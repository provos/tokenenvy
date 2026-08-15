<script module lang="ts">
  import type { QuotaWindow, ScanStatus } from '$lib/types';

  const scanStates = new Set<ScanStatus['state']>(['idle', 'discovering', 'scanning', 'error']);
  const quotaFreshnessMs = 15 * 60_000;

  function isNonNegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
  }

  /** Parse the untrusted EventSource payload before it can update dashboard state. */
  export function parseScanStatus(data: string): ScanStatus | null {
    try {
      const value = JSON.parse(data) as Record<string, unknown>;
      if (
        !value ||
        typeof value !== 'object' ||
        !scanStates.has(value.state as ScanStatus['state']) ||
        !isNonNegativeInteger(value.filesDiscovered) ||
        !isNonNegativeInteger(value.filesScanned) ||
        !isNonNegativeInteger(value.bytesRead) ||
        !isNonNegativeInteger(value.rowsRead) ||
        !isNonNegativeInteger(value.invalidRows) ||
        !isNonNegativeInteger(value.revision) ||
        (value.updatedAt !== null && typeof value.updatedAt !== 'string') ||
        (value.lastError !== null && typeof value.lastError !== 'string')
      ) {
        return null;
      }
      return value as unknown as ScanStatus;
    } catch {
      return null;
    }
  }

  export function scanRefreshTarget(
    analyticsRevision: number | null,
    statusRevision: number,
  ): 'none' | 'quota' | 'dashboard' {
    if (analyticsRevision === null || statusRevision < analyticsRevision) return 'none';
    return statusRevision === analyticsRevision ? 'quota' : 'dashboard';
  }

  export function quotaWindowIsStale(window: QuotaWindow, now: number): boolean {
    const observedAt = Date.parse(window.observedAt);
    const resetsAt = Date.parse(window.resetsAt);
    return (
      window.stale ||
      !Number.isFinite(observedAt) ||
      !Number.isFinite(resetsAt) ||
      now - observedAt > quotaFreshnessMs ||
      now >= resetsAt
    );
  }

  export function selectActiveDate(
    selectedDate: string | null,
    today: string,
    todayCount: number,
    dates: string[],
  ): string | null {
    const availableDates = [...new Set(dates)].sort();
    if (selectedDate && availableDates.includes(selectedDate)) return selectedDate;
    if (todayCount > 0) return today;
    return availableDates.at(-1) ?? null;
  }

  export function rangeButtonState(
    pendingRangeDays: number | null,
    days: number,
  ): { disabled: boolean; busy: boolean } {
    return {
      disabled: pendingRangeDays !== null,
      busy: pendingRangeDays === days,
    };
  }

  export function modelFamilyRailState(
    modelCount: number,
    loading: boolean,
  ): 'models' | 'loading' | 'empty' {
    if (modelCount > 0) return 'models';
    return loading ? 'loading' : 'empty';
  }

  function quotaWindowExpiresAt(window: QuotaWindow): number | null {
    const observedAt = Date.parse(window.observedAt);
    const resetsAt = Date.parse(window.resetsAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(resetsAt)) return null;
    return Math.min(observedAt + quotaFreshnessMs + 1, resetsAt);
  }
</script>

<script lang="ts">
  import { browser } from '$app/environment';
  import { resolve } from '$app/paths';
  import { onDestroy, onMount } from 'svelte';
  import DayHero from '$lib/components/DayHero.svelte';
  import DailyChart from '$lib/components/DailyChart.svelte';
  import HistogramDrawer from '$lib/components/HistogramDrawer.svelte';
  import ScanProgress from '$lib/components/ScanProgress.svelte';
  import ShareModal from '$lib/components/ShareModal.svelte';
  import WeeklyRecapModal from '$lib/components/WeeklyRecapModal.svelte';
  import { SECURITY_BLUEPRINTS_LEGAL_NAME, SECURITY_BLUEPRINTS_URL } from '$lib/components/brand';
  import { compactNumber, dayLabel, FAMILY_COLORS } from '$lib/components/chart';
  import { DASHBOARD_SHARE_CTA, weeklyRecapReady } from '$lib/components/weekly-recap';
  import type {
    DayDetailResponse,
    ModelFamily,
    OverviewResponse,
    QuotaResponse,
    SeriesResponse,
  } from '$lib/types';

  const ranges = [28, 90, 365] as const;
  const allFamilies: ModelFamily[] = ['opus', 'sonnet', 'fable', 'haiku', 'other'];

  interface DataQualityResponse {
    rows: number;
    invalidRows: number;
  }

  let overview = $state<OverviewResponse | null>(null);
  let series = $state<SeriesResponse | null>(null);
  let quota = $state<QuotaResponse | null>(null);
  let quotaClock = $state(Date.now());
  let dataQuality = $state<DataQualityResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let refreshError = $state<{ message: string; requestedDays: (typeof ranges)[number] } | null>(
    null,
  );
  let rangeDays = $state<(typeof ranges)[number]>(28);
  let pendingRangeDays = $state<(typeof ranges)[number] | null>(null);
  let visibleFamilies = $state<ModelFamily[]>([...allFamilies]);
  let theme = $state<'dark' | 'light'>('dark');
  let selectedDate = $state<string | null>(null);
  let dayDetail = $state<DayDetailResponse | null>(null);
  let dayLoading = $state(false);
  let dayError = $state<string | null>(null);
  let drawerOpen = $state(false);
  let dayDetailRevision: number | null = null;
  let dayRequestRevision: number | null = null;
  let shareOpen = $state(false);
  let weeklyRecapOpen = $state(false);
  let eventSource: EventSource | null = null;
  let dashboardRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let quotaRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let loadSequence = 0;
  let quotaLoadSequence = 0;
  let dayLoadSequence = 0;
  let analyticsRevision: number | null = null;
  let latestScanStatus: ScanStatus | null = null;

  let hasData = $derived(Boolean(overview?.headline.count || series?.points.length));
  let latestUpdate = $derived(formatUpdate(overview?.generatedAt));
  let shareReady = $derived(Boolean(dayDetail && !dayLoading && !dayError));
  let recapReady = $derived(overview ? weeklyRecapReady(overview.weekly.recap) : false);
  let modelRailState = $derived(modelFamilyRailState(dayDetail?.models.length ?? 0, dayLoading));
  let selectedDayLabel = $derived(
    selectedDate
      ? selectedDate === overview?.today
        ? 'Today'
        : dayLabel(selectedDate)
      : 'Selected day',
  );
  let selectedAnnouncement = $derived(
    dayDetail
      ? `${selectedDayLabel} selected. Median ${Math.round(dayDetail.summary.median)} effective output tokens per second across ${dayDetail.summary.count} measured requests.${dayLoading ? ' Updating in the background.' : ''}`
      : dayLoading && selectedDate
        ? `Loading ${selectedDayLabel.toLowerCase()}.`
        : dayError && selectedDate
          ? `${selectedDayLabel} could not be loaded.`
          : '',
  );
  let qualityRatio = $derived(
    dataQuality && dataQuality.rows > 0
      ? Math.max(0, 1 - dataQuality.invalidRows / dataQuality.rows)
      : null,
  );
  let sevenDayQuotaStale = $derived(
    quota?.sevenDay ? quotaWindowIsStale(quota.sevenDay, quotaClock) : false,
  );
  let displayedScanStatus = $derived(latestScanStatus ?? overview?.scan ?? null);
  let selectedDayRefusals = $derived.by(() => {
    const selected = overview?.refusals.byDay.find((item) => item.date === dayDetail?.date);
    return {
      recorded: overview?.refusals.recorded === true,
      attempted: selected?.attempted ?? 0,
      recovered: selected?.recovered ?? 0,
      userVisible: selected?.userVisible ?? 0,
    };
  });

  $effect(() => {
    const window = quota?.sevenDay;
    if (!window || quotaWindowIsStale(window, quotaClock)) return;
    const expiresAt = quotaWindowExpiresAt(window);
    if (expiresAt === null) return;
    const timer = setTimeout(
      () => {
        quotaClock = Date.now();
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  });

  function formatUpdate(value?: string): string {
    if (!value) return 'Waiting for first scan';
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return 'Updated recently';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 10) return 'Updated just now';
    if (seconds < 60) return `Updated ${seconds}s ago`;
    return `Updated ${Math.floor(seconds / 60)}m ago`;
  }

  function formatQuotaObservation(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return 'an earlier run';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(timestamp);
  }

  async function getJson<T>(url: string, optional = false): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (optional && response.status === 404) return null;
      if (!response.ok) throw new Error(`The local service returned ${response.status}`);
      return (await response.json()) as T;
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new Error('The local service took more than 30 seconds to respond.', { cause });
      }
      throw cause;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadDashboard(showLoading = false, requestedDays = rangeDays) {
    if (dashboardRefreshTimer) {
      clearTimeout(dashboardRefreshTimer);
      dashboardRefreshTimer = null;
    }
    if (quotaRefreshTimer) {
      clearTimeout(quotaRefreshTimer);
      quotaRefreshTimer = null;
    }
    const sequence = ++loadSequence;
    const quotaSequence = ++quotaLoadSequence;
    const rangeChange = requestedDays !== rangeDays;
    if (showLoading) loading = true;
    if (rangeChange) pendingRangeDays = requestedDays;
    if (!overview) error = null;
    try {
      const [nextOverview, nextSeries, nextQuota, nextDataQuality] = await Promise.all([
        getJson<OverviewResponse>('/api/v1/overview'),
        getJson<SeriesResponse>(`/api/v1/series?days=${requestedDays}`),
        getJson<QuotaResponse>('/api/v1/quota', true).catch(() => null),
        getJson<DataQualityResponse>('/api/v1/data-quality'),
      ]);
      if (sequence !== loadSequence) return;
      const nextRevision = nextOverview?.scan.revision ?? null;
      analyticsRevision = nextRevision;
      overview =
        nextOverview && latestScanStatus && latestScanStatus.revision >= nextOverview.scan.revision
          ? { ...nextOverview, scan: latestScanStatus }
          : nextOverview;
      series = nextSeries;
      if (quotaSequence === quotaLoadSequence) {
        quota = nextQuota;
        quotaClock = Date.now();
      }
      dataQuality = nextDataQuality;
      rangeDays = requestedDays;
      if (rangeChange || !refreshError || refreshError.requestedDays === requestedDays)
        refreshError = null;
      reconcileSelectedDay(nextOverview, nextSeries, nextRevision);
      if (
        latestScanStatus &&
        analyticsRevision !== null &&
        latestScanStatus.revision > analyticsRevision
      ) {
        scheduleDashboardRefresh();
      }
    } catch (cause) {
      if (sequence !== loadSequence) return;
      const message = cause instanceof Error ? cause.message : 'Could not reach the local scanner.';
      if (overview && series) refreshError = { message, requestedDays };
      else error = message;
    } finally {
      if (sequence === loadSequence) {
        loading = false;
        pendingRangeDays = null;
      }
    }
  }

  async function refreshQuota() {
    const sequence = ++quotaLoadSequence;
    try {
      const nextQuota = await getJson<QuotaResponse>('/api/v1/quota', true);
      if (sequence === quotaLoadSequence) {
        quota = nextQuota;
        quotaClock = Date.now();
      }
    } catch {
      // Keep the last known quota; overview and trends remain valid.
    }
  }

  function scheduleDashboardRefresh() {
    if (quotaRefreshTimer) {
      clearTimeout(quotaRefreshTimer);
      quotaRefreshTimer = null;
    }
    if (dashboardRefreshTimer) clearTimeout(dashboardRefreshTimer);
    dashboardRefreshTimer = setTimeout(() => {
      dashboardRefreshTimer = null;
      void loadDashboard(false, pendingRangeDays ?? rangeDays);
    }, 350);
  }

  function scheduleQuotaRefresh() {
    if (quotaRefreshTimer) clearTimeout(quotaRefreshTimer);
    quotaRefreshTimer = setTimeout(() => {
      quotaRefreshTimer = null;
      void refreshQuota();
    }, 350);
  }

  function handleScanEvent(event: MessageEvent<string>) {
    const status = parseScanStatus(event.data);
    if (!status) return;
    latestScanStatus = status;

    if (overview && status.revision >= overview.scan.revision) {
      overview = { ...overview, scan: status };
    }
    const target = scanRefreshTarget(analyticsRevision, status.revision);
    if (target === 'dashboard') scheduleDashboardRefresh();
    else if (target === 'quota') scheduleQuotaRefresh();
  }

  function connectEvents() {
    eventSource?.close();
    eventSource = new EventSource('/api/v1/events');
    eventSource.addEventListener('scan', handleScanEvent);
    eventSource.onerror = () => {
      // EventSource reconnects automatically. The dashboard remains usable meanwhile.
    };
  }

  function reconcileSelectedDay(
    nextOverview: OverviewResponse | null,
    nextSeries: SeriesResponse | null,
    revision: number | null,
  ) {
    if (!nextOverview || !nextSeries) return;
    const target = selectActiveDate(
      selectedDate,
      nextOverview.today,
      nextOverview.headline.count,
      nextSeries.points.map((point) => point.date),
    );

    if (!target) {
      clearSelectedDay();
      return;
    }

    const requestAlreadyCurrent =
      dayLoading && selectedDate === target && dayRequestRevision === revision;
    const detailIsCurrent =
      dayDetail?.date === target && dayDetailRevision === revision && !dayError;
    if (!requestAlreadyCurrent && !detailIsCurrent) void selectDay(target, true);
  }

  async function selectDay(date: string, force = false) {
    const revision = analyticsRevision;
    const dateChanged = selectedDate !== date;
    if (!force && !dateChanged && dayDetail?.date === date && dayDetailRevision === revision)
      return;
    const sequence = ++dayLoadSequence;
    if (dateChanged) {
      drawerOpen = false;
      shareOpen = false;
      dayDetail = null;
      dayDetailRevision = null;
    }
    selectedDate = date;
    dayError = null;
    dayLoading = true;
    dayRequestRevision = revision;
    try {
      const detail = await getJson<DayDetailResponse>(`/api/v1/days/${encodeURIComponent(date)}`);
      if (sequence !== dayLoadSequence || selectedDate !== date) return;
      dayDetail = detail;
      dayDetailRevision = revision;
    } catch (cause) {
      if (sequence !== dayLoadSequence || selectedDate !== date) return;
      if (dayDetail?.date !== date) {
        dayDetail = null;
        dayDetailRevision = null;
      }
      dayError = cause instanceof Error ? cause.message : 'Could not load the selected day.';
    } finally {
      if (sequence === dayLoadSequence && selectedDate === date) {
        dayLoading = false;
        dayRequestRevision = null;
      }
    }
  }

  function clearSelectedDay() {
    dayLoadSequence += 1;
    selectedDate = null;
    dayDetail = null;
    dayDetailRevision = null;
    dayRequestRevision = null;
    dayError = null;
    dayLoading = false;
    drawerOpen = false;
    shareOpen = false;
  }

  function retrySelectedDay() {
    if (selectedDate) void selectDay(selectedDate, true);
  }

  function openDayDetails() {
    if (dayDetail && !dayLoading) drawerOpen = true;
  }

  function toggleFamily(family: ModelFamily) {
    if (visibleFamilies.includes(family)) {
      if (visibleFamilies.length > 1)
        visibleFamilies = visibleFamilies.filter((item) => item !== family);
    } else {
      visibleFamilies = [...visibleFamilies, family];
    }
  }

  function applyTheme(next: 'dark' | 'light') {
    theme = next;
    if (browser) {
      document.documentElement.dataset.theme = next;
      localStorage.setItem('token-envy-theme', next);
    }
  }

  onMount(() => {
    const saved = localStorage.getItem('token-envy-theme');
    applyTheme(saved === 'light' ? 'light' : 'dark');
    connectEvents();
    void loadDashboard(true);
  });

  onDestroy(() => {
    dayLoadSequence += 1;
    eventSource?.close();
    if (dashboardRefreshTimer) clearTimeout(dashboardRefreshTimer);
    if (quotaRefreshTimer) clearTimeout(quotaRefreshTimer);
  });
</script>

<svelte:head>
  <title>Token Envy · Local Claude Code performance</title>
</svelte:head>

<div class="app-shell">
  <header class="topbar">
    <a class="brand" href={resolve('/')} aria-label="Token Envy home">
      <span class="brand-mark" aria-hidden="true">T</span>
      <span>Token Envy</span>
    </a>

    <div class="topbar-meta">
      {#if overview}
        <span
          class:scanning={overview.scan.state === 'scanning' ||
            overview.scan.state === 'discovering'}
          class="live-status"
        >
          <i></i>{overview.scan.state === 'idle' ? 'Live' : overview.scan.state}
        </span>
        <span class="privacy-pill" title="No prompt or response content leaves this device"
          >Private · local only</span
        >
      {/if}
      <div class="range-control" aria-label="Chart range">
        {#each ranges as days (days)}
          {@const rangeState = rangeButtonState(pendingRangeDays, days)}
          <button
            class:active={rangeDays === days}
            aria-pressed={rangeDays === days}
            aria-busy={rangeState.busy}
            disabled={rangeState.disabled}
            onclick={() => loadDashboard(false, days)}
          >
            {days === 365 ? '1y' : `${days}d`}
          </button>
        {/each}
      </div>
      <button
        class="icon-button theme-toggle"
        aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
        onclick={() => applyTheme(theme === 'dark' ? 'light' : 'dark')}
        >{theme === 'dark' ? '☼' : '◐'}</button
      >
      <button
        class="share-button"
        disabled={!shareReady}
        title={shareReady
          ? `Share ${selectedDayLabel.toLowerCase()}`
          : 'Select a measured day to create a share card'}
        onclick={() => (shareOpen = true)}
      >
        <span aria-hidden="true">↗</span> Share
      </button>
    </div>
  </header>

  <main>
    {#if loading && !overview}
      <section class="loading-state" aria-live="polite">
        <div class="loading-orbit"><span></span></div>
        <p class="eyebrow">Reading private metadata</p>
        <h1>Warming up Token Envy</h1>
        <p>
          The first scan may take a moment. The dashboard is already listening for new sessions.
        </p>
        <ScanProgress status={displayedScanStatus} />
        <div class="skeleton-grid" aria-hidden="true">
          <i></i><i></i><i></i>
        </div>
      </section>
    {:else if error && !overview}
      <section class="error-state" role="alert">
        <span class="error-glyph">!</span>
        <p class="eyebrow">Dashboard offline</p>
        <h1>We lost the local signal</h1>
        <p>{error}</p>
        <button class="primary-button" onclick={() => loadDashboard(true)}>Try again</button>
      </section>
    {:else if overview && !hasData}
      <section class="empty-state">
        {#if displayedScanStatus?.state === 'discovering' || displayedScanStatus?.state === 'scanning' || displayedScanStatus?.state === 'error'}
          <div class="loading-orbit"><span></span></div>
          <p class="eyebrow">
            {displayedScanStatus.state === 'error'
              ? 'Scanner needs attention'
              : 'Building your private index'}
          </p>
          <h1>
            {displayedScanStatus.state === 'error'
              ? 'We couldn’t finish the first scan'
              : 'Reading your Claude Code history'}
          </h1>
          <p>
            {displayedScanStatus.state === 'error'
              ? 'Your existing local data is safe. The scanner details are shown below.'
              : 'The dashboard will appear as soon as the first complete scan is ready.'}
          </p>
          <ScanProgress status={displayedScanStatus} />
        {:else}
          <div class="empty-gauge" aria-hidden="true"><span></span></div>
          <p class="eyebrow">Live scanner ready</p>
          <h1>Your first reading will appear here</h1>
          <p>
            Use Claude Code as usual. Eligible requests are summarized locally as soon as a session
            log is completed.
          </p>
          <div class="empty-details">
            <span><b>{overview.scan.filesDiscovered}</b> log files found</span>
            <span><b>{overview.scan.rowsRead.toLocaleString()}</b> events inspected</span>
            <span><b>0</b> prompts retained</span>
          </div>
        {/if}
      </section>
    {:else if overview && series}
      <section class="dashboard-grid">
        <div class="dashboard-main">
          <p class="sr-only" aria-live="polite" aria-atomic="true">{selectedAnnouncement}</p>
          <DayHero
            date={selectedDate}
            today={overview.today}
            detail={dayDetail}
            loading={dayLoading}
            error={dayError}
            onretry={retrySelectedDay}
            onmore={openDayDetails}
          />

          <section class="envy-callout" aria-labelledby="envy-callout-title">
            <div>
              <p class="eyebrow">{DASHBOARD_SHARE_CTA.eyebrow}</p>
              <h2 id="envy-callout-title">{DASHBOARD_SHARE_CTA.title}</h2>
              <p>{DASHBOARD_SHARE_CTA.body}</p>
              <small>{DASHBOARD_SHARE_CTA.note}</small>
            </div>
            <div class="envy-callout-actions">
              <button
                class="secondary-button"
                type="button"
                disabled={!shareReady}
                onclick={() => (shareOpen = true)}>Share {selectedDayLabel.toLowerCase()}</button
              >
              <button
                class="primary-button"
                type="button"
                disabled={!recapReady}
                onclick={() => (weeklyRecapOpen = true)}>Recap my week</button
              >
            </div>
          </section>

          <section class="panel trend-panel">
            <div class="section-heading chart-heading">
              <div>
                <p class="eyebrow">Longitudinal view</p>
                <h2>How fast has Claude Code felt?</h2>
                <p>
                  Daily median with the middle 50% shaded. Whiskers show the clustered 95%
                  confidence interval when eligible.
                </p>
              </div>
              <span class="freshness">{latestUpdate}</span>
            </div>

            <div class="family-filters" aria-label="Visible model families">
              {#each allFamilies as family (family)}
                {@const model = overview.models.find((item) => item.family === family)}
                {#if model || series.points.some((point) => point.family === family)}
                  <button
                    class:inactive={!visibleFamilies.includes(family)}
                    aria-pressed={visibleFamilies.includes(family)}
                    onclick={() => toggleFamily(family)}
                  >
                    <i style={`--model-color:${FAMILY_COLORS[family]}`}></i>{family}
                  </button>
                {/if}
              {/each}
            </div>

            {#if refreshError}
              <div class="refresh-error" role="alert">
                <span>{refreshError.message} Showing the last successful {rangeDays}-day view.</span
                >
                <button
                  onclick={() => loadDashboard(false, refreshError?.requestedDays ?? rangeDays)}
                  >Retry</button
                >
              </div>
            {/if}

            {#if pendingRangeDays !== null}
              <div class="range-loading" role="status" aria-live="polite">
                <span class="range-loading-spinner" aria-hidden="true"></span>
                <span>
                  <strong
                    >Loading {pendingRangeDays === 365
                      ? 'the 1-year'
                      : `the ${pendingRangeDays}-day`} view…</strong
                  >
                  <small
                    >Keeping the current {rangeDays === 365 ? '1-year' : `${rangeDays}-day`} chart visible
                    until it is ready.</small
                  >
                </span>
              </div>
            {/if}

            {#if series.points.length}
              <DailyChart
                points={series.points}
                timezone={series.timezone}
                today={overview.today}
                {visibleFamilies}
                {selectedDate}
                onselect={selectDay}
              />
              <p class="chart-hint">
                Select a day to update the summary. Use “More info” for its full distribution.
              </p>
            {:else}
              <div class="subtle-empty">No eligible daily measurements in this range yet.</div>
            {/if}
          </section>
        </div>

        <aside class="dashboard-rail" aria-label="Usage and performance at a glance">
          <section class="panel rail-panel" aria-busy={dayLoading}>
            <div class="section-heading compact-heading">
              <div>
                <p class="eyebrow">Model families</p>
                <h2>{selectedDayLabel} mix</h2>
              </div>
            </div>
            <div class="model-list">
              {#if modelRailState === 'models' && dayDetail}
                {#if dayLoading}
                  <span class="sr-only" role="status"
                    >Updating the model mix in the background.</span
                  >
                {/if}
                {#each dayDetail.models as model (model.family)}
                  <div class="rail-model">
                    <div class="rail-model-name">
                      <i style={`--model-color:${FAMILY_COLORS[model.family]}`}></i>
                      <span
                        ><strong>{model.family}</strong><small
                          >{model.count.toLocaleString()} requests</small
                        ></span
                      >
                    </div>
                    <div class="rail-model-value">
                      <strong>{model.median.toFixed(1)}</strong><small>tok/s</small>
                    </div>
                    <span class="mix-track"
                      ><i
                        style={`--model-color:${FAMILY_COLORS[model.family]};--model-share:${model.share * 100}%`}
                      ></i></span
                    >
                  </div>
                {/each}
              {:else if modelRailState === 'loading'}
                <p class="subtle-empty rail-empty">Loading the selected day…</p>
              {:else}
                <p class="subtle-empty rail-empty">No model readings for the selected day.</p>
              {/if}
            </div>
          </section>

          <section class="panel rail-panel weekly-panel">
            <div class="section-heading compact-heading">
              <div>
                <p class="eyebrow">This calendar week</p>
                <h2>Observed usage</h2>
              </div>
            </div>
            <strong class="large-rail-number">{compactNumber(overview.weekly.outputTokens)}</strong>
            <span class="large-rail-label">output tokens recorded</span>
            <div class="week-progress">
              <i style={`--week-progress:${Math.min(100, overview.weekly.elapsedFraction * 100)}%`}
              ></i>
            </div>
            <div class="weekly-grid">
              <span
                ><small>Projected</small><strong
                  >{overview.weekly.projectedOutputTokens === null
                    ? '—'
                    : compactNumber(overview.weekly.projectedOutputTokens)}</strong
                ></span
              >
              <span
                ><small>4-week median</small><strong
                  >{overview.weekly.previousFourWeekMedian === null
                    ? '—'
                    : compactNumber(overview.weekly.previousFourWeekMedian)}</strong
                ></span
              >
            </div>
            <p>This is locally observed usage, not an account quota.</p>
            <button
              class="secondary-button weekly-recap-button"
              type="button"
              disabled={!recapReady}
              title={recapReady
                ? 'Open your private weekly recap'
                : 'A recap appears after the first measured request this week'}
              onclick={() => (weeklyRecapOpen = true)}>Open weekly recap</button
            >
            {#if quota?.available && quota.sevenDay}
              <div class="quota-reading" class:stale={sevenDayQuotaStale}>
                {#if sevenDayQuotaStale}
                  <span
                    ><strong>Stale</strong> status-line sample from {formatQuotaObservation(
                      quota.sevenDay.observedAt,
                    )}</span
                  >
                {:else}
                  <span
                    ><strong>{quota.sevenDay.usedPercentage.toFixed(0)}%</strong> of reported 7-day window</span
                  >
                  <div><i style={`--quota-progress:${quota.sevenDay.usedPercentage}%`}></i></div>
                {/if}
              </div>
            {/if}
          </section>

          <section class="panel rail-panel refusal-panel">
            <div class="section-heading compact-heading">
              <div>
                <p class="eyebrow">All recorded history</p>
                <h2>Classifier refusals</h2>
              </div>
              {#if overview.refusals.recorded}<span class="recorded-pill">Explicit only</span>{/if}
            </div>
            {#if overview.refusals.recorded}
              <div class="refusal-total">
                <strong>{overview.refusals.attempted}</strong><span>attempted</span>
              </div>
              <div class="refusal-grid">
                <span
                  ><i class="recovered"></i><strong>{overview.refusals.recovered}</strong><small
                    >recovered by fallback</small
                  ></span
                >
                <span
                  ><i class="visible"></i><strong>{overview.refusals.userVisible}</strong><small
                    >user-visible</small
                  ></span
                >
                <span
                  ><i class="unknown"></i><strong>{overview.refusals.unknown}</strong><small
                    >unknown outcome</small
                  ></span
                >
              </div>
              <p>
                {overview.refusals.perThousand === null
                  ? 'Rate unavailable'
                  : `${overview.refusals.perThousand.toFixed(2)} attempts per 1,000 measured requests`}.
              </p>
            {:else}
              <p class="subtle-empty rail-empty">
                This log format does not expose explicit classifier outcomes.
              </p>
            {/if}
          </section>
        </aside>
      </section>

      <section class="trust-grid">
        <article class="trust-card">
          <span class="trust-index">01</span>
          <p class="eyebrow">Reliability</p>
          <h2>Built for messy, living logs</h2>
          <p>
            Copied history is deduplicated. Partial lines wait. Late events reopen provisional
            requests. Truncated files are reconciled.
          </p>
          <div class="trust-stat">
            <strong>{qualityRatio === null ? '—' : `${(qualityRatio * 100).toFixed(2)}%`}</strong>
            <span>rows parsed cleanly</span>
          </div>
        </article>
        <article class="trust-card">
          <span class="trust-index">02</span>
          <p class="eyebrow">Privacy</p>
          <h2>Your work stays yours</h2>
          <p>
            The scanner stores aggregate timing metadata—not prompts, responses, commands, project
            names, paths, or refusal explanations.
          </p>
          <div class="trust-stat"><strong>0</strong><span>automatic network requests</span></div>
        </article>
        <article class="trust-card methodology-card">
          <span class="trust-index">03</span>
          <p class="eyebrow">Methodology</p>
          <h2>An honest measure of felt speed</h2>
          <p>
            Effective output tokens/s divides output tokens by inferred end-to-end wall time. It
            includes queueing, prompt processing, hidden reasoning, and first-token latency—not just
            decoder speed.
          </p>
          <details>
            <summary>What gets excluded?</summary>
            <p>
              Synthetic events, non-positive token counts, missing parents, invalid timestamps,
              sub-100ms intervals, and hour-scale gaps. Confidence intervals require 20 requests
              across five sessions.
            </p>
          </details>
        </article>
      </section>
    {/if}
  </main>

  <footer class="site-footer">
    <span>Token Envy</span>
    <span>
      Private by default · Open source · Local-first ·
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- This is an external brand link. -->
      <a href={SECURITY_BLUEPRINTS_URL} target="_blank" rel="noopener noreferrer">
        A {SECURITY_BLUEPRINTS_LEGAL_NAME} project · securityblueprints.io
      </a>
    </span>
  </footer>
</div>

<HistogramDrawer
  open={drawerOpen}
  loading={dayLoading}
  detail={dayDetail}
  refusals={selectedDayRefusals}
  error={dayError}
  onclose={() => (drawerOpen = false)}
/>

{#if overview && dayDetail}
  <ShareModal
    open={shareOpen}
    detail={dayDetail}
    refusals={selectedDayRefusals}
    isToday={dayDetail.date === overview.today}
    onclose={() => (shareOpen = false)}
  />
{/if}

{#if overview}
  <WeeklyRecapModal
    open={weeklyRecapOpen}
    recap={overview.weekly.recap}
    outputTokens={overview.weekly.outputTokens}
    onclose={() => (weeklyRecapOpen = false)}
  />
{/if}
