const statusLabels = {
  live: "配信中",
  upcoming: "配信予定",
  past: "配信終了",
};

const emptyStates = {
  live: ["配信中のライブはありません", "「今後の配信」から次のライブをチェックできます。"],
  upcoming: ["今後の配信予定はありません", "配信予定が公開されると、ここに表示されます。"],
  past: ["表示できる過去の配信はありません", "終了から24時間以内の配信と、設定で残した配信が表示されます。"],
};

const timeZone = "Asia/Tokyo";
const shortDay = new Intl.DateTimeFormat("ja-JP", { timeZone, month: "long", day: "numeric", weekday: "short" });
const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const clock = new Intl.DateTimeFormat("ja-JP", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const nameOrder = new Intl.Collator("ja-JP");

const byId = (id) => document.getElementById(id);
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
  status: "live",
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

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function searchValue(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ja-JP").trim();
}

function setMessage(node, value = "", kind = "success") {
  node.textContent = value;
  node.dataset.kind = kind;
  node.hidden = !value;
}

function updateDate() {
  const now = new Date();
  byId("today-date").dateTime = dateKey.format(now);
  byId("today-date").textContent = shortDay.format(now);
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
      updateDate();
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
  const sourceUrl = httpsUrl(source);
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
  const streamUrl = httpsUrl(stream.url);
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

function renderStreams(streams, channels) {
  const groups = new Map();
  for (const stream of streams) {
    const date = validDate(stream.startAt);
    const key = date ? dateKey.format(date) : "";
    if (!groups.has(key)) {
      groups.set(key, { title: date ? shortDay.format(date) : "日時未定", streams: [] });
    }
    groups.get(key).streams.push(stream);
  }

  return [...groups.values()].map((group) => {
    const section = element("section", "stream-group");
    const list = element("div", "stream-list");
    list.append(...group.streams.map((stream) => renderStream(stream, channels.get(stream.channelId))));
    section.append(element("h3", "stream-day", group.title), list);
    return section;
  });
}

function renderSchedule() {
  const { data, loading, error, status } = state;
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
    if (groups && groups !== channel?.group) return false;
    return !query || searchValue(stream.title).includes(query) || searchValue(channel?.name).includes(query);
  });

  for (const key of Object.keys(statusLabels)) {
    byId("count-" + key).textContent = matches.filter((stream) => stream.status === key).length;
  }

  const visible = matches.filter((stream) => stream.status === status);
  visible.sort((left, right) => {
    const leftDate = validDate(left.startAt);
    const rightDate = validDate(right.startAt);
    if (!leftDate || !rightDate) return Number(!leftDate) - Number(!rightDate);
    return status === "past" ? rightDate - leftDate : leftDate - rightDate;
  });

  if (visible.length) {
    schedulePanel.replaceChildren(...renderStreams(visible, channels));
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
  const url = httpsUrl(channel.url);
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
scheduleSearch.addEventListener("input", renderSchedule);
scheduleGroup.addEventListener("change", renderSchedule);
rosterSearch.addEventListener("input", () => renderRoster());
rosterGroup.addEventListener("change", () => renderRoster());
retainedFilter.addEventListener("change", () => renderRoster());
hiddenFilter.addEventListener("change", () => renderRoster());

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

updateDate();
loadSchedule();
window.setInterval(() => {
  updateDate();
  if (!document.hidden && !state.loading && !dialog.open) loadSchedule();
}, 90_000);
