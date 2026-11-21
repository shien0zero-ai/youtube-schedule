const statusLabels = {
  live: "配信中",
  upcoming: "配信予定",
  past: "配信終了",
};

const mvStatusLabels = {
  live: "プレミア公開中",
  upcoming: "公開予定",
  past: "公開済み",
};

const musicKindLabels = { original: "オリジナル", cover: "カバー" };
const mvMetrics = {
  views: { field: "viewCount", label: "再生回数" },
  trending: { field: "viewGain7d", label: "過去7日間の再生増加数" },
  likes: { field: "likeCount", label: "高評価数" },
};

const platformLabels = new Map([
  ["youtube", "YouTube"],
  ["youtube.com", "YouTube"],
  ["youtu.be", "YouTube"],
  ["twitch.tv", "Twitch"],
  ["twitcasting.tv", "ツイキャス"],
  ["tiktok.com", "TikTok"],
  ["bilibili.com", "bilibili"],
  ["nicovideo.jp", "ニコニコ"],
  ["spotify.com", "Spotify"],
  ["x.com", "X"],
  ["twitter.com", "X"],
]);

const emptyStates = {
  all: ["表示できる配信はありません", ""],
  live: ["配信中のライブはありません", "「今後の配信」から次のライブをチェックできます。"],
  upcoming: ["今後の配信予定はありません", "配信予定が公開されると、ここに表示されます。"],
  past: ["表示できる過去の配信はありません", "自動で取得した配信と、手動で登録した配信が表示されます。"],
};

const timeZone = "Asia/Tokyo";
const dayMilliseconds = 24 * 60 * 60 * 1000;
const catalogPageSize = 40;
const catalogTabs = {
  special: { items: "specialLives", count: "specialLivesCount", label: "3Dライブ" },
  mv: { items: "musicVideos", count: "musicVideosCount", label: "MV" },
};
const shortDay = new Intl.DateTimeFormat("ja-JP", { timeZone, month: "long", day: "numeric", weekday: "short" });
const archiveDay = new Intl.DateTimeFormat("ja-JP", { timeZone, year: "numeric", month: "long", day: "numeric", weekday: "short" });
const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const clock = new Intl.DateTimeFormat("ja-JP", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const nameOrder = new Intl.Collator("ja-JP");
const gainFormat = new Intl.NumberFormat("ja-JP", { signDisplay: "exceptZero" });

const byId = (id) => document.getElementById(id);
const dateInput = byId("schedule-date");
const dateShortcuts = [...document.querySelectorAll("[data-date-offset]")];
const schedulePanel = byId("schedule-panel");
const scheduleSearch = byId("schedule-search");
const scheduleGroup = byId("schedule-group");
const mvControls = byId("mv-controls");
const mvSortButtons = [...byId("mv-sort").querySelectorAll("[data-mv-order]")];
const mvKindButtons = [...byId("mv-kind").querySelectorAll("[data-mv-kind]")];
const dialog = byId("settings-dialog");
const rosterSearch = byId("roster-search");
const rosterGroup = byId("roster-group");
const retainedFilter = byId("roster-retained");
const hiddenFilter = byId("roster-hidden");
const form = byId("add-channel-form");
const channelUrl = byId("channel-url");
const archiveDialog = byId("archive-dialog");
const archiveForm = byId("archive-form");
const archiveDate = byId("archive-date");
const archiveChannel = byId("archive-channel");
const archiveSpecial = byId("archive-special");
const archiveCsvForm = byId("archive-csv-form");
const refreshButton = byId("refresh");
const tabs = [...document.querySelectorAll(".tab")];

const state = {
  status: "all",
  dateSelection: "today",
  catalogViews: {
    special: { dateSelection: "", limit: catalogPageSize },
    mv: { dateSelection: "", limit: catalogPageSize },
  },
  mvOrder: "newest",
  mvKind: "",
  data: null,
  error: null,
  loading: true,
  loadMode: null,
  loadVersion: 0,
  pendingChannels: new Set(),
};

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function webUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function streamPlatform(platform, url) {
  const name = platform || (url && new URL(url).hostname) || "";
  const host = name.toLowerCase().replace(/^www\./, "");
  for (const [domain, label] of platformLabels) {
    if (host === domain || host.endsWith("." + domain)) return label;
  }
  return name;
}

function searchValue(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja-JP")
    .replace(/[\u30a1-\u30f6\u30fd-\u30fe]/g, (kana) => String.fromCharCode(kana.charCodeAt(0) - 0x60))
    .replace(/[\s・'’]+/g, "");
}

function matchesChannelName(channel, query) {
  return [channel.name, ...(channel.aliases ?? [])].some((name) => searchValue(name).includes(query));
}

function setMessage(node, value = "", kind = "success") {
  node.textContent = value;
  node.dataset.kind = kind;
  node.hidden = !value;
}

function jstDateKey(date) {
  const parts = Object.fromEntries(dateKey.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
}

function streamDay(stream) {
  const date = validDate(stream.startAt ?? stream.publishedAt);
  return date ? jstDateKey(date) : stream.scheduleDate ?? "";
}

function newestFirst(streams) {
  const dated = streams.map((stream) => {
    const start = validDate(stream.startAt ?? stream.publishedAt);
    return { stream, day: start ? jstDateKey(start) : stream.scheduleDate ?? "", time: start?.getTime() ?? Number.MIN_SAFE_INTEGER };
  });
  dated.sort((left, right) => right.day.localeCompare(left.day) || right.time - left.time);
  return dated.map(({ stream }) => stream);
}

function sortMusicVideos(videos, channels, order) {
  const metric = mvMetrics[order]?.field;
  if (metric) {
    // The fetched list starts in date order, which stays intact for equal or missing values.
    videos.sort((left, right) => {
      const leftKnown = Number.isFinite(left[metric]);
      const rightKnown = Number.isFinite(right[metric]);
      if (leftKnown && rightKnown) return right[metric] - left[metric];
      return Number(rightKnown) - Number(leftKnown);
    });
  } else if (order === "member") {
    const readings = new Map(videos.map((video) => {
      const channelName = channels.get(video.channelId)?.name ?? video.channelName;
      return [video, searchValue(video.memberReading?.trim() || channelName)];
    }));
    videos.sort((left, right) => {
      const leftReading = readings.get(left);
      const rightReading = readings.get(right);
      return Number(!leftReading) - Number(!rightReading) || nameOrder.compare(leftReading, rightReading) ||
        nameOrder.compare(left.title ?? "", right.title ?? "");
    });
  }
}

function dayLabel(day, formatter = shortDay) {
  const date = validDate(`${day}T00:00:00+09:00`);
  return date ? formatter.format(date) : day;
}

function relativeDate(offset, now) {
  if (offset === "all") return "";
  return jstDateKey(new Date(now.getTime() + Number(offset) * dayMilliseconds));
}

function selectedDate(selection, now) {
  return selection === "today" ? jstDateKey(now) : selection;
}

function updateDateControls(selected, now) {
  if (dateInput.value !== selected) dateInput.value = selected;
  for (const button of dateShortcuts) {
    button.setAttribute("aria-pressed", String(relativeDate(button.dataset.dateOffset, now) === selected));
  }
}

function selectDate(date, { now = new Date(), status = state.status } = {}) {
  const selection = date === jstDateKey(now) ? "today" : date;
  const catalog = state.catalogViews[status];
  if (catalog) {
    catalog.dateSelection = selection;
    catalog.limit = catalogPageSize;
  } else {
    state.dateSelection = selection;
  }
  return selectTab(byId(catalog ? "tab-" + status : "tab-all"));
}

async function request(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error("サーバーに接続できませんでした。");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("サーバーから配信データを受信できませんでした。");
  }
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "リクエストに失敗しました。");
  }
  return payload;
}

function setGroups(select, channels) {
  const selected = select.value;
  const groups = [...new Set(channels.map((channel) => channel.group).filter(Boolean))];
  groups.sort(nameOrder.compare);
  select.replaceChildren(
    new Option("すべてのグループ", ""),
    ...groups.map((group) => new Option(group, group)),
  );
  if (groups.includes(selected)) select.value = selected;
}

function updateChannelControls(channels) {
  const visible = channels.filter((channel) => !channel.hidden);
  setGroups(scheduleGroup, visible);
  setGroups(rosterGroup, channels);
  byId("channel-count").textContent = visible.length.toLocaleString("ja-JP");
  updateArchiveChannels(channels);
}

function updateArchiveChannels(channels) {
  const eligible = channels.filter(({ hidden, specialLiveEligible }) => !hidden && (!archiveSpecial.checked || specialLiveEligible));
  const selected = archiveChannel.value;
  const placeholder = new Option(eligible.length ? "チャンネルを選択" : "登録できるチャンネルがありません", "", true, true);
  placeholder.disabled = true;
  eligible.sort((left, right) => nameOrder.compare(left.name, right.name));
  archiveChannel.replaceChildren(placeholder, ...eligible.map(({ name, id }) => new Option(name, id)));
  if (eligible.some(({ id }) => id === selected)) archiveChannel.value = selected;
}

async function loadSchedule({ refresh = false } = {}) {
  const version = ++state.loadVersion;
  const mode = catalogTabs[state.status] ? state.status : "schedule";
  const params = new URLSearchParams();
  if (mode !== "special") params.set("special", "0");
  if (mode === "mv") params.set("mv", "1");
  if (refresh) params.set("refresh", "1");
  const query = params.toString();
  state.loading = true;
  state.loadMode = mode;
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  renderSchedule();
  try {
    const data = await request(query ? "/api/schedule?" + query : "/api/schedule", { cache: "no-store" });
    if (version !== state.loadVersion) return;
    for (const { items } of Object.values(catalogTabs)) {
      if (Array.isArray(data[items])) data[items] = newestFirst(data[items]);
    }
    state.data = data;
    state.error = null;
    updateChannelControls(data.channels);
    if (dialog.open) renderRoster();
  } catch (error) {
    if (version === state.loadVersion) state.error = error.message;
  } finally {
    if (version === state.loadVersion) {
      state.loading = false;
      state.loadMode = null;
      refreshButton.disabled = false;
      refreshButton.removeAttribute("aria-busy");
      renderSchedule();
      if (dialog.open && !state.data) renderRoster();
    }
  }
}

function renderAlerts() {
  const node = byId("schedule-alerts");
  const messages = [...(state.data?.warnings ?? [])];
  if (state.status === "mv") messages.push(state.data?.musicVideosWarning);
  const warnings = [...new Set(messages)].filter(Boolean);
  const catalog = catalogTabs[state.status];
  const hasContent = state.data && (!catalog || Array.isArray(state.data[catalog.items]));
  if (state.error && hasContent) warnings.unshift("更新に失敗したため、直前に取得した情報を表示しています。");
  node.hidden = warnings.length === 0;
  node.replaceChildren();
  if (warnings.length === 1) {
    node.textContent = warnings[0];
  } else if (warnings.length > 1) {
    const list = element("ul");
    list.append(...warnings.map((message) => element("li", "", message)));
    node.append(list);
  }
}

function stateCard(title, description, { loading = false, action, actionLabel } = {}) {
  const card = element("div", "state-card");
  const icon = element("div", "state-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.append(element("span", loading ? "spinner" : "radio-icon"));
  card.append(icon, element("h3", "", title));
  if (description) card.append(element("p", "", description));
  if (action) {
    const button = element("button", "button secondary", actionLabel);
    button.type = "button";
    button.addEventListener("click", action);
    card.append(button);
  }
  return card;
}

function media(container, source, fallbackText) {
  const sourceUrl = webUrl(source);
  const showFallback = () => container.replaceChildren(element("span", "", fallbackText));
  if (!sourceUrl) {
    showFallback();
    return;
  }
  const image = element("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", showFallback, { once: true });
  image.src = sourceUrl;
  container.append(image);
}

function renderStream(stream, channel, { mv = false, showDay = false, order = "newest" } = {}) {
  const streamUrl = webUrl(stream.url);
  const card = element(streamUrl ? "a" : "article", "stream");
  if (streamUrl) {
    card.href = streamUrl;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
  }

  const preview = element("div", "stream-thumb");
  preview.setAttribute("aria-hidden", "true");
  media(preview, stream.thumbnail, "▶");

  const body = element("div", "stream-body");
  const meta = element("div", "stream-meta");
  const unconfirmed = stream.archiveUnconfirmed === true && (mv || stream.status === "past");
  const labels = mv ? mvStatusLabels : statusLabels;
  const unconfirmedLabel = mv ? "公開未確認" : "アーカイブ未確認";
  const badge = element("span", "status-badge", unconfirmed ? unconfirmedLabel : labels[stream.status]);
  badge.dataset.status = stream.status;
  if (unconfirmed) badge.dataset.archiveUnconfirmed = "true";
  meta.append(badge);
  const streamDate = validDate(stream.startAt ?? stream.publishedAt);
  if (streamDate) {
    const clockLabel = clock.format(streamDate);
    const time = element("time", "", showDay ? `${archiveDay.format(streamDate)} ${clockLabel}` : clockLabel);
    time.dateTime = streamDate.toISOString();
    meta.append(time);
  } else if (showDay && stream.scheduleDate) {
    meta.append(element("span", "", dayLabel(stream.scheduleDate, archiveDay)));
  }
  const platform = streamPlatform(stream.platform, streamUrl);
  if (platform) meta.append(element("span", "stream-platform", platform));
  if (mv) {
    const kind = musicKindLabels[stream.musicKind];
    if (kind) meta.append(element("span", "", kind));
    if (Number.isFinite(stream.viewCount)) {
      meta.append(element("span", "stream-views", `${stream.viewCount.toLocaleString("ja-JP")} 回再生`));
    }
    if (order === "trending" && Number.isFinite(stream.viewGain7d)) {
      meta.append(element("span", "stream-metric", `直近7日以内で ${gainFormat.format(stream.viewGain7d)} 回再生`));
    }
    if (order === "likes" && Number.isFinite(stream.likeCount)) {
      meta.append(element("span", "stream-metric", `${stream.likeCount.toLocaleString("ja-JP")} 件の高評価`));
    }
  }
  body.append(meta, element("h4", "stream-title", stream.title || "タイトル未定"));
  const channelName = channel?.name ?? stream.channelName;
  if (channelName) body.append(element("p", "stream-channel", channelName));
  card.append(preview, body);
  if (streamUrl) {
    const arrow = element("span", "stream-arrow", "↗");
    arrow.setAttribute("aria-hidden", "true");
    card.append(arrow);
  }
  return card;
}

function renderStreamList(streams, channels, options) {
  const list = element("div", "stream-list");
  list.append(...streams.map((stream) => renderStream(stream, channels.get(stream.channelId), options)));
  return list;
}

function renderStreams(streams, channels, { descending, dateFormat = shortDay, mv = false }) {
  const groups = new Map();
  for (const stream of streams) {
    const day = streamDay(stream);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(stream);
  }

  const days = [...groups.keys()].filter(Boolean).sort();
  if (descending) days.reverse();
  if (groups.has("")) days.push("");
  return days.map((day) => {
    const section = element("section", "stream-group");
    const list = renderStreamList(groups.get(day), channels, { mv });
    section.append(element("h3", "stream-day", day ? dayLabel(day, dateFormat) : "日時未定"), list);
    return section;
  });
}

function renderAfterFilterChange() {
  for (const catalog of Object.values(state.catalogViews)) catalog.limit = catalogPageSize;
  renderSchedule();
}

function setMusicKind(kind) {
  state.mvKind = kind;
  state.catalogViews.mv.limit = catalogPageSize;
  for (const button of mvKindButtons) button.setAttribute("aria-pressed", String(button.dataset.mvKind === kind));
}

function renderMore(catalog) {
  const control = element("div", "schedule-more");
  const button = element("button", "button secondary", "さらに表示");
  button.type = "button";
  button.addEventListener("click", () => {
    const previousLimit = catalog.limit;
    catalog.limit += catalogPageSize;
    renderSchedule();
    const firstNew = schedulePanel.querySelectorAll(".stream")[previousLimit];
    if (firstNew) {
      if (firstNew.tagName !== "A") firstNew.tabIndex = -1;
      firstNew.focus();
    }
  });
  control.append(button);
  return control;
}

function renderSchedule() {
  const { data, loading, error, status } = state;
  const now = new Date();
  const catalog = catalogTabs[status];
  const catalogView = state.catalogViews[status];
  const mv = status === "mv";
  const musicKind = mv ? state.mvKind : "";
  const flatMusicList = mv && state.mvOrder !== "newest";
  const scheduleDate = selectedDate(state.dateSelection, now);
  const date = catalogView ? selectedDate(catalogView.dateSelection, now) : scheduleDate;
  mvControls.hidden = !mv;
  updateDateControls(date, now);
  const updated = validDate(data?.updatedAt);
  byId("sync-status").textContent = loading
    ? "配信情報を取得中"
    : updated ? "最終更新 " + clock.format(updated) + " JST" : "配信情報を取得できませんでした";
  schedulePanel.setAttribute("aria-busy", String(loading));
  renderAlerts();

  if (!data) {
    const subject = catalog?.label ?? "配信情報";
    if (loading) {
      schedulePanel.replaceChildren(stateCard(`${subject}を取得しています`, "", { loading: true }));
    } else {
      schedulePanel.replaceChildren(stateCard(`${subject}を取得できませんでした`, error, {
        action: () => loadSchedule({ refresh: true }),
        actionLabel: "もう一度試す",
      }));
    }
    return;
  }

  const groups = scheduleGroup.value;
  const query = searchValue(scheduleSearch.value);
  const channels = new Map(data.channels.map((channel) => [channel.id, channel]));
  const matchingChannels = query ? new Set(data.channels.filter((channel) => matchesChannelName(channel, query)).map(({ id }) => id)) : null;
  const matchesFilters = (stream) => {
    const channel = channels.get(stream.channelId);
    if (channel?.hidden) return false;
    if (groups && groups !== (channel?.group ?? stream.channelGroup)) return false;
    return !query || matchingChannels.has(stream.channelId) || searchValue(stream.title).includes(query) ||
      (!channel && searchValue(stream.channelName).includes(query)) ||
      (stream.memberReading && searchValue(stream.memberReading).includes(query));
  };
  const matches = data.streams.filter((stream) => (!scheduleDate || streamDay(stream) === scheduleDate) && matchesFilters(stream));
  const matchingCatalog = catalog ? data[catalog.items]?.filter((stream) => (
    (!date || streamDay(stream) === date) && (!musicKind || stream.musicKind === musicKind) && matchesFilters(stream)
  )) : null;

  byId("count-all").textContent = matches.length;
  for (const key of Object.keys(statusLabels)) {
    byId("count-" + key).textContent = matches.filter((stream) => stream.status === key).length;
  }
  for (const [key, { items, count }] of Object.entries(catalogTabs)) {
    const shownCount = status === key ? matchingCatalog?.length : null;
    byId("count-" + key).textContent = shownCount ?? data[count] ?? data[items]?.length ?? "—";
  }

  const visible = catalog ? matchingCatalog : status === "all" ? matches : matches.filter((stream) => stream.status === status);
  const descending = Boolean(catalog) || status === "past";
  if (!catalog) {
    visible.sort((left, right) => {
      const leftDate = validDate(left.startAt);
      const rightDate = validDate(right.startAt);
      if (!leftDate || !rightDate) return Number(!leftDate) - Number(!rightDate);
      return descending ? rightDate - leftDate : leftDate - rightDate;
    });
  } else if (flatMusicList && visible) {
    sortMusicVideos(visible, channels, state.mvOrder);
  }

  const content = [];
  if (status === "special") {
    const heading = element("div", "catalog-heading");
    heading.append(
      element("h3", "", "3Dライブの予定とアーカイブ"),
      element("p", "", "ホロジュールの配信予定と、ホロライブ公式チャンネル・メンバーの公開アーカイブを掲載します。"),
    );
    content.push(heading);
  } else if (mv) {
    const heading = element("div", "catalog-heading");
    heading.append(element("h3", "", "ミュージックビデオ"));
    const metric = mvMetrics[state.mvOrder];
    if (metric && visible?.length && !visible.some((video) => Number.isFinite(video[metric.field]))) {
      heading.append(element("p", "", `${metric.label}がまだ確認できないため、新着順で表示しています。`));
    }
    content.push(heading);
  }

  if (!visible) {
    content.push(loading
      ? stateCard(`${catalog.label}を取得しています`, "", { loading: true })
      : stateCard(`${catalog.label}を取得できませんでした`, error, { action: () => loadSchedule(), actionLabel: "もう一度試す" }));
  } else if (visible.length) {
    const shown = catalogView ? visible.slice(0, catalogView.limit) : visible;
    if (flatMusicList) {
      content.push(renderStreamList(shown, channels, { mv, showDay: true, order: state.mvOrder }));
    } else {
      content.push(...renderStreams(shown, channels, { descending, dateFormat: catalog ? archiveDay : shortDay, mv }));
    }
    if (shown.length < visible.length) content.push(renderMore(catalogView));
  } else if (groups || query || musicKind) {
    content.push(stateCard(mv ? "条件に一致するMVはありません" : "条件に一致する配信はありません", "", {
      action: () => {
        scheduleGroup.value = "";
        scheduleSearch.value = "";
        if (musicKind) setMusicKind("");
        renderAfterFilterChange();
        scheduleSearch.focus();
      },
      actionLabel: "絞り込みを解除",
    }));
  } else if (catalog && date) {
    content.push(stateCard(`${dayLabel(date, archiveDay)}の${catalog.label}はありません`, "", {
      action: () => selectDate(""),
      actionLabel: "全日程を表示",
    }));
  } else if (catalog) {
    content.push(stateCard(`表示できる${catalog.label}はありません`, ""));
  } else if (data.warnings?.length || error) {
    content.push(stateCard("この区分の配信情報はありません", "取得できた範囲の情報を表示しています。"));
  } else if (date && status === "all") {
    content.push(stateCard(`${dayLabel(date)}の配信はありません`, "取得済みの範囲から表示しています。"));
  } else {
    content.push(stateCard(...emptyStates[status]));
  }
  schedulePanel.replaceChildren(...content);
}

function selectTab(tab) {
  state.status = tab.dataset.status;
  for (const candidate of tabs) {
    candidate.setAttribute("aria-selected", String(candidate === tab));
    candidate.tabIndex = candidate === tab ? 0 : -1;
  }
  schedulePanel.setAttribute("aria-labelledby", tab.id);
  const catalog = catalogTabs[state.status];
  if (catalog && state.loadMode !== state.status && (state.loadMode || !Array.isArray(state.data?.[catalog.items]))) {
    return loadSchedule();
  }
  renderSchedule();
}

function rosterRow(channel) {
  const row = element("li", "roster-row");
  row.dataset.channelId = channel.id;
  const avatar = element("div", "roster-avatar");
  avatar.setAttribute("aria-hidden", "true");
  media(avatar, channel.avatar, Array.from(channel.name)[0] || "▶");
  const identity = element("div", "roster-identity");
  const url = webUrl(channel.url);
  const name = element(url ? "a" : "span", "roster-name", channel.name);
  if (url) {
    name.href = url;
    name.target = "_blank";
    name.rel = "noopener noreferrer";
  }
  const group = element("span", "roster-group", channel.group);
  if (channel.hidden) group.append(element("span", "hidden-badge", "非表示"));
  identity.append(name, group);
  row.append(avatar, identity);

  if (!channel.hidden) {
    const label = element("label", "roster-switch-label");
    const toggle = element("input", "roster-switch");
    toggle.type = "checkbox";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", channel.name + "の過去の配信を残す");
    toggle.dataset.toggle = channel.id;
    toggle.checked = channel.keepPast;
    toggle.disabled = state.pendingChannels.has(channel.id);
    toggle.addEventListener("change", () => {
      mutateChannel(channel, "PATCH", { keepPast: toggle.checked }, "過去の配信の設定を保存しました。", "toggle");
    });
    label.append(toggle, element("span", "", "過去の配信を残す"));
    row.append(label);
  }

  const actionName = channel.hidden ? "再表示" : channel.custom ? "削除" : "非表示";
  const action = element("button", channel.custom ? "button roster-action remove-button" : "button secondary roster-action", actionName);
  action.type = "button";
  action.dataset.action = channel.id;
  action.disabled = state.pendingChannels.has(channel.id);
  action.setAttribute("aria-label", channel.name + "を" + actionName);
  action.addEventListener("click", () => {
    if (channel.hidden) {
      mutateChannel(channel, "PATCH", { hidden: false }, "チャンネルを再表示しました。", "action");
      return;
    }
    if (channel.custom && !window.confirm(channel.name + "を一覧から削除しますか？")) return;
    const message = channel.custom ? "チャンネルを削除しました。" : "チャンネルを非表示にしました。";
    mutateChannel(channel, "DELETE", undefined, message, "action");
  });
  row.append(action);
  return row;
}

function renderRoster(focusAfter) {
  const list = byId("roster-list");
  const query = searchValue(rosterSearch.value);
  const group = rosterGroup.value;
  const current = document.activeElement?.dataset;
  const focus = focusAfter ?? (current?.toggle ? ["toggle", current.toggle] : current?.action ? ["action", current.action] : null);
  const channels = (state.data?.channels ?? []).filter((channel) => {
    if (group && channel.group !== group) return false;
    if (retainedFilter.checked && !channel.keepPast) return false;
    if (hiddenFilter.checked && !channel.hidden) return false;
    return !query || matchesChannelName(channel, query);
  });
  list.replaceChildren();
  if (channels.length) {
    list.append(...channels.map(rosterRow));
  } else {
    const text = state.loading && !state.data ? "チャンネル情報を取得中…" : "表示できるチャンネルはありません。";
    list.append(element("li", "roster-empty", text));
  }
  if (focus) {
    const target = [...list.querySelectorAll('[data-' + focus[0] + ']')].find((control) => control.dataset[focus[0]] === focus[1]);
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else if (focusAfter) rosterSearch.focus({ preventScroll: true });
  }
}

async function mutateChannel(channel, method, body, success, focusTarget) {
  const message = byId("settings-message");
  state.pendingChannels.add(channel.id);
  setMessage(message);
  const row = [...byId("roster-list").children].find((candidate) => candidate.dataset.channelId === channel.id);
  row?.querySelectorAll("input, button").forEach((control) => {
    control.disabled = true;
  });

  try {
    await request("/api/channels/" + encodeURIComponent(channel.id), {
      method,
      ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const current = state.data.channels.find(({ id }) => id === channel.id);
    if (method === "DELETE") {
      if (channel.custom) {
        state.data.channels = state.data.channels.filter(({ id }) => id !== channel.id);
      } else if (current) {
        current.hidden = true;
      }
      state.data.streams = state.data.streams.filter(({ channelId }) => channelId !== channel.id);
      for (const { items, count } of Object.values(catalogTabs)) {
        if (Array.isArray(state.data[items])) {
          state.data[items] = state.data[items].filter(({ channelId }) => channelId !== channel.id);
          state.data[count] = state.data[items].length;
        }
      }
    } else if (current) {
      Object.assign(current, body);
    }
    updateChannelControls(state.data.channels);
    setMessage(message, success);
    await loadSchedule();
  } catch (error) {
    setMessage(message, error.message, "error");
  } finally {
    state.pendingChannels.delete(channel.id);
    if (dialog.open) renderRoster([focusTarget, channel.id]);
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    const current = tabs.indexOf(tab);
    const indices = {
      ArrowLeft: (current - 1 + tabs.length) % tabs.length,
      ArrowRight: (current + 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    if (!(event.key in indices)) return;
    event.preventDefault();
    const next = tabs[indices[event.key]];
    selectTab(next);
    next.focus();
  });
}
for (const button of document.querySelectorAll("[data-open-settings]")) {
  button.addEventListener("click", () => {
    setMessage(byId("settings-message"));
    renderRoster();
    dialog.showModal();
    rosterSearch.focus();
  });
}

byId("open-archive").addEventListener("click", () => {
  const today = jstDateKey(new Date());
  archiveDate.max = today;
  archiveDate.value = dateInput.value && dateInput.value <= today ? dateInput.value : today;
  setMessage(byId("archive-message"));
  setMessage(byId("archive-csv-message"));
  archiveDialog.showModal();
});

async function submitArchives(form, { contentType, body, date, special = false }) {
  const fields = form.querySelector("fieldset");
  const button = form.querySelector("button[type='submit']");
  const message = form.querySelector(".form-message");
  const label = button.textContent;
  setMessage(message);
  fields.disabled = true;
  button.textContent = "登録中…";
  try {
    const { added, skipped } = await request("/api/archives", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    form.reset();
    let reload;
    if (date) {
      archiveDate.value = date;
      updateArchiveChannels(state.data?.channels ?? []);
      reload = selectDate(date, { status: special ? "special" : "all" });
    }
    setMessage(message, `追加 ${added} 件、スキップ ${skipped} 件。`);
    await (reload ?? loadSchedule());
  } catch (error) {
    setMessage(message, error.message, "error");
  } finally {
    fields.disabled = false;
    button.textContent = label;
  }
}

archiveForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const { specialLive, ...entry } = Object.fromEntries(new FormData(archiveForm));
  if (specialLive) entry.specialLive = true;
  submitArchives(archiveForm, {
    contentType: "application/json",
    body: JSON.stringify({ entries: [entry] }),
    date: entry.date,
    special: entry.specialLive,
  });
});

archiveSpecial.addEventListener("change", () => updateArchiveChannels(state.data?.channels ?? []));

archiveCsvForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const file = byId("archive-csv-file").files[0];
  if (file) submitArchives(archiveCsvForm, { contentType: "text/csv", body: file });
});

refreshButton.addEventListener("click", () => loadSchedule({ refresh: true }));
dateInput.addEventListener("change", () => selectDate(dateInput.value));
for (const button of dateShortcuts) {
  button.addEventListener("click", () => {
    const now = new Date();
    selectDate(relativeDate(button.dataset.dateOffset, now), { now });
  });
}
scheduleSearch.addEventListener("input", renderAfterFilterChange);
scheduleGroup.addEventListener("change", renderAfterFilterChange);
for (const button of mvSortButtons) {
  button.addEventListener("click", () => {
    const order = button.dataset.mvOrder;
    if (state.mvOrder === order) return;
    state.mvOrder = order;
    state.catalogViews.mv.limit = catalogPageSize;
    for (const candidate of mvSortButtons) candidate.setAttribute("aria-pressed", String(candidate === button));
    renderSchedule();
  });
}
for (const button of mvKindButtons) {
  button.addEventListener("click", () => {
    if (button.dataset.mvKind === state.mvKind) return;
    setMusicKind(button.dataset.mvKind);
    renderSchedule();
  });
}
rosterSearch.addEventListener("input", () => renderRoster());
rosterGroup.addEventListener("change", () => renderRoster());
retainedFilter.addEventListener("change", () => renderRoster());
hiddenFilter.addEventListener("change", () => renderRoster());

function addCodespacesHelp(launcher, appUrl) {
  const style = launcher.createElement("style");
  style.textContent = `
    body { margin: 0; padding: 2rem 1.2rem; background: #f8f8f2; color: #202a25; font: 16px/1.7 system-ui, sans-serif; }
    main { max-width: 36rem; margin: 4vh auto; padding: clamp(1.25rem, 5vw, 2.5rem); border: 1px solid #dce3db; border-radius: 18px; background: #fff; }
    h1 { margin: 0 0 .6rem; }
    p { margin: 0 0 1rem; }
    a { color: #235641; text-underline-offset: .15em; }
    #open-schedule { display: inline-block; padding: .55rem .9rem; border-radius: 8px; background: #235641; color: #fff; text-decoration: none; font-weight: 700; }
  `;
  launcher.head.append(style);
  launcher.body.innerHTML = `
    <main>
      <h1>配信日和</h1>
      <p><a id="open-schedule" target="_blank" rel="noopener noreferrer">配信日和を開く</a></p>
      <p>開けない場合は <a href="https://github.com/codespaces" target="_blank" rel="noopener noreferrer">GitHub Codespaces</a> から使っていた Codespace を再開し、アプリを起動してからもう一度開いてください。</p>
    </main>
  `;
  launcher.getElementById("open-schedule").href = appUrl.href;

  const script = launcher.createElement("script");
  script.textContent = 'window.open(document.getElementById("open-schedule").href, "_blank", "noopener,noreferrer");';
  launcher.body.append(script);
}

byId("download-launcher").addEventListener("click", () => {
  const appUrl = new URL("/", window.location.origin);
  const launcher = document.implementation.createHTMLDocument("配信日和");
  launcher.documentElement.lang = "ja";

  const charset = launcher.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  launcher.head.prepend(charset);
  const viewport = launcher.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  launcher.head.append(viewport);

  if (appUrl.hostname.endsWith(".app.github.dev")) {
    addCodespacesHelp(launcher, appUrl);
  } else {
    const refresh = launcher.createElement("meta");
    refresh.httpEquiv = "refresh";
    refresh.content = "0;url=" + appUrl.href;
    launcher.head.append(refresh);

    const link = launcher.createElement("a");
    link.href = appUrl.href;
    link.textContent = "配信日和を開く";
    launcher.body.append(link);
  }

  const blob = new Blob(["<!doctype html>\n", launcher.documentElement.outerHTML], { type: "text/html;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const download = element("a");
  download.href = downloadUrl;
  download.download = "youtube-schedule.html";
  document.body.append(download);
  download.click();
  download.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type='submit']");
  const message = byId("add-message");
  const value = channelUrl.value.trim();
  setMessage(message);
  channelUrl.disabled = true;
  button.disabled = true;
  button.textContent = "確認中…";
  try {
    await request("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: value }),
    });
    form.reset();
    setMessage(message, "チャンネルを追加しました。");
    await loadSchedule();
  } catch (error) {
    setMessage(message, error.message, "error");
  } finally {
    channelUrl.disabled = false;
    button.disabled = false;
    button.textContent = "チャンネルを追加";
  }
});

loadSchedule();
window.setInterval(() => {
  if (!document.hidden && !state.loading && !dialog.open && !archiveDialog.open) loadSchedule();
}, 90_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderSchedule();
});
