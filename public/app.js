const statusLabels = {
  live: "配信中",
  upcoming: "配信予定",
  past: "配信終了",
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
  past: ["表示できる過去の配信はありません", "公式スケジュールに掲載中の過去配信、終了から24時間以内の配信、設定で残した配信が表示されます。"],
};

const timeZone = "Asia/Tokyo";
const dayMilliseconds = 24 * 60 * 60 * 1000;
const shortDay = new Intl.DateTimeFormat("ja-JP", { timeZone, month: "long", day: "numeric", weekday: "short" });
const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const clock = new Intl.DateTimeFormat("ja-JP", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const nameOrder = new Intl.Collator("ja-JP");

const byId = (id) => document.getElementById(id);
const dateInput = byId("schedule-date");
const dateShortcuts = [...document.querySelectorAll("[data-date-offset]")];
const schedulePanel = byId("schedule-panel");
const scheduleSearch = byId("schedule-search");
const scheduleGroup = byId("schedule-group");
const dialog = byId("settings-dialog");
const rosterSearch = byId("roster-search");
const rosterGroup = byId("roster-group");
const retainedFilter = byId("roster-retained");
const hiddenFilter = byId("roster-hidden");
const form = byId("add-channel-form");
const channelUrl = byId("channel-url");
const refreshButton = byId("refresh");
const tabs = [...document.querySelectorAll(".tab")];

const state = {
  status: "all",
  dateSelection: "today",
  data: null,
  error: null,
  loading: true,
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
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja-JP").trim();
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
  const date = validDate(stream.startAt);
  return date ? jstDateKey(date) : stream.scheduleDate ?? "";
}

function dayLabel(day) {
  const date = validDate(`${day}T00:00:00+09:00`);
  return date ? shortDay.format(date) : day;
}

function relativeDate(offset, now) {
  if (offset === "all") return "";
  return jstDateKey(new Date(now.getTime() + Number(offset) * dayMilliseconds));
}

function updateDateControls() {
  const now = new Date();
  const selected = state.dateSelection === "today" ? jstDateKey(now) : state.dateSelection;
  if (dateInput.value !== selected) dateInput.value = selected;
  for (const button of dateShortcuts) {
    button.setAttribute("aria-pressed", String(relativeDate(button.dataset.dateOffset, now) === selected));
  }
  return selected;
}

function selectDate(date, now = new Date()) {
  state.dateSelection = date === jstDateKey(now) ? "today" : date;
  selectTab(byId("tab-all"));
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
}

async function loadSchedule({ refresh = false } = {}) {
  const version = ++state.loadVersion;
  state.loading = true;
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  renderSchedule();
  try {
    const data = await request(refresh ? "/api/schedule?refresh=1" : "/api/schedule", { cache: "no-store" });
    if (version !== state.loadVersion) return;
    state.data = data;
    state.error = null;
    updateChannelControls(data.channels);
    if (dialog.open) renderRoster();
  } catch (error) {
    if (version === state.loadVersion) state.error = error.message;
  } finally {
    if (version === state.loadVersion) {
      state.loading = false;
      refreshButton.disabled = false;
      refreshButton.removeAttribute("aria-busy");
      renderSchedule();
      if (dialog.open && !state.data) renderRoster();
    }
  }
}

function renderAlerts() {
  const node = byId("schedule-alerts");
  const warnings = [...new Set(state.data?.warnings ?? [])].filter(Boolean);
  if (state.error && state.data) warnings.unshift("更新に失敗したため、直前に取得した情報を表示しています。");
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

function renderStream(stream, channel) {
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
  const badge = element("span", "status-badge", statusLabels[stream.status]);
  badge.dataset.status = stream.status;
  meta.append(badge);
  const streamDate = validDate(stream.startAt);
  if (streamDate) {
    const time = element("time", "", clock.format(streamDate));
    time.dateTime = streamDate.toISOString();
    meta.append(time);
  }
  const platform = streamPlatform(stream.platform, streamUrl);
  if (platform) meta.append(element("span", "stream-platform", platform));
  body.append(meta, element("h4", "stream-title", stream.title || "タイトル未定"));
  if (channel?.name) body.append(element("p", "stream-channel", channel.name));
  card.append(preview, body);
  if (streamUrl) {
    const arrow = element("span", "stream-arrow", "↗");
    arrow.setAttribute("aria-hidden", "true");
    card.append(arrow);
  }
  return card;
}

function renderStreams(streams, channels, descending) {
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
    const list = element("div", "stream-list");
    list.append(...groups.get(day).map((stream) => renderStream(stream, channels.get(stream.channelId))));
    section.append(element("h3", "stream-day", day ? dayLabel(day) : "日時未定"), list);
    return section;
  });
}

function renderSchedule() {
  const { data, loading, error, status } = state;
  const date = updateDateControls();
  const updated = validDate(data?.updatedAt);
  byId("sync-status").textContent = loading
    ? "配信情報を取得中"
    : updated ? "最終更新 " + clock.format(updated) + " JST" : "配信情報を取得できませんでした";
  schedulePanel.setAttribute("aria-busy", String(loading));
  renderAlerts();

  if (!data) {
    if (loading) {
      schedulePanel.replaceChildren(stateCard("配信情報を取得しています", "", { loading: true }));
    } else {
      schedulePanel.replaceChildren(stateCard("配信情報を取得できませんでした", error, {
        action: () => loadSchedule({ refresh: true }),
        actionLabel: "もう一度試す",
      }));
    }
    return;
  }

  const groups = scheduleGroup.value;
  const query = searchValue(scheduleSearch.value);
  const channels = new Map(data.channels.map((channel) => [channel.id, channel]));
  const matches = data.streams.filter((stream) => {
    const channel = channels.get(stream.channelId);
    if (channel?.hidden) return false;
    if (date && streamDay(stream) !== date) return false;
    if (groups && groups !== channel?.group) return false;
    return !query || searchValue(stream.title).includes(query) || searchValue(channel?.name).includes(query);
  });

  byId("count-all").textContent = matches.length;
  for (const key of Object.keys(statusLabels)) {
    byId("count-" + key).textContent = matches.filter((stream) => stream.status === key).length;
  }

  const visible = status === "all" ? matches : matches.filter((stream) => stream.status === status);
  const descending = status === "past";
  visible.sort((left, right) => {
    const leftDate = validDate(left.startAt);
    const rightDate = validDate(right.startAt);
    if (!leftDate || !rightDate) return Number(!leftDate) - Number(!rightDate);
    return descending ? rightDate - leftDate : leftDate - rightDate;
  });

  if (visible.length) {
    schedulePanel.replaceChildren(...renderStreams(visible, channels, descending));
  } else if (groups || query) {
    schedulePanel.replaceChildren(stateCard("条件に一致する配信はありません", "", {
      action: () => {
        scheduleGroup.value = "";
        scheduleSearch.value = "";
        renderSchedule();
        scheduleSearch.focus();
      },
      actionLabel: "絞り込みを解除",
    }));
  } else if (data.warnings?.length || error) {
    schedulePanel.replaceChildren(stateCard("この区分の配信情報はありません", "取得できた範囲の情報を表示しています。"));
  } else if (date && status === "all") {
    schedulePanel.replaceChildren(stateCard(`${dayLabel(date)}の配信はありません`, "取得済みの範囲から表示しています。"));
  } else {
    schedulePanel.replaceChildren(stateCard(...emptyStates[status]));
  }
}

function selectTab(tab) {
  state.status = tab.dataset.status;
  for (const candidate of tabs) {
    candidate.setAttribute("aria-selected", String(candidate === tab));
    candidate.tabIndex = candidate === tab ? 0 : -1;
  }
  schedulePanel.setAttribute("aria-labelledby", tab.id);
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
    return !query || searchValue(channel.name).includes(query);
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

refreshButton.addEventListener("click", () => loadSchedule({ refresh: true }));
dateInput.addEventListener("change", () => selectDate(dateInput.value));
for (const button of dateShortcuts) {
  button.addEventListener("click", () => {
    const now = new Date();
    selectDate(relativeDate(button.dataset.dateOffset, now), now);
  });
}
scheduleSearch.addEventListener("input", renderSchedule);
scheduleGroup.addEventListener("change", renderSchedule);
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
  if (!document.hidden && !state.loading && !dialog.open) loadSchedule();
}, 90_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderSchedule();
});
