"use strict";

const STORAGE = {
  shopping: "nakupnyZoznam_neonMEGA_items",
  events: "spolu_calendar_events_v1",
  tasks: "spolu_tasks_v1",
  device: "nakupny_zoznam_device_v2",
  unsaved: "nakupny_zoznam_unsaved_v2",
  history: "nakupnyZoznam_item_history_v1",
  activeView: "spolu_active_view_v1"
};

const SHEETS_SYNC_URL = "https://script.google.com/macros/s/AKfycbw260UlklkZ4KEtiTvfHtvRr_z3R1Te5Ne3Foch9e38nBuWaeo1Y9eRY7dLKqONmyquFg/exec";
const AUTO_SAVE_DELAY = 850;
const FOREGROUND_SYNC_GAP = 12000;
const PULL_THRESHOLD = 84;
const VALID_COLORS = new Set(["aqua", "coral", "sun", "leaf", "blue"]);
const VALID_PRIORITIES = new Set(["low", "normal", "high"]);
const VALID_ASSIGNEES = new Set(["both", "domi", "peto"]);

const state = {
  shopping: [],
  events: [],
  tasks: [],
  activeView: localStorage.getItem(STORAGE.activeView) || "shopping",
  selectedDate: dateKey(new Date()),
  calendarCursor: startOfMonth(new Date()),
  history: loadJson(STORAGE.history, {}),
  unsaved: localStorage.getItem(STORAGE.unsaved) === "1",
  revision: 0,
  syncing: false,
  syncQueued: false,
  backendLimited: false,
  connectionError: false,
  syncTimer: null,
  lastSyncAt: 0,
  toastTimer: null,
  pull: null,
  drag: null,
  suppressItemClickUntil: 0
};

const device = loadDevice();

function $(selector) {
  return document.querySelector(selector);
}

function $$(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function nowIso() {
  return new Date().toISOString();
}

function timeMs(value) {
  const result = value ? new Date(value).getTime() : 0;
  return Number.isFinite(result) ? result : 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

function parseDateKey(value) {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) {
    return new Date();
  }
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1, 12, 0, 0, 0);
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function detectDeviceType() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || "") ? "mobile" : "desktop";
}

function loadDevice() {
  const fallbackType = detectDeviceType();
  const stored = loadJson(STORAGE.device, {});
  const result = {
    id: stored && stored.id ? String(stored.id) : uid(),
    type: stored && stored.type ? String(stored.type) : fallbackType,
    label: stored && stored.label ? String(stored.label) : (fallbackType === "mobile" ? "Mobil" : "PC")
  };
  saveJson(STORAGE.device, result);
  return result;
}

function stamp(record, timestamp) {
  const value = timestamp || nowIso();
  record.updatedAt = value;
  record.updatedById = device.id;
  record.updatedByType = device.type;
  record.updatedByLabel = device.label;
  return record;
}

function creationFields(record) {
  const createdAt = record.createdAt || record.updatedAt || record.boughtAt || record.doneAt || "";
  return {
    createdAt: String(createdAt || ""),
    createdById: String(record.createdById || record.updatedById || ""),
    createdByType: String(record.createdByType || record.updatedByType || ""),
    createdByLabel: String(record.createdByLabel || record.updatedByLabel || "")
  };
}

function earliestCreation(left, right) {
  const leftTime = timeMs(left && left.createdAt);
  const rightTime = timeMs(right && right.createdAt);
  if (leftTime && rightTime) return leftTime <= rightTime ? left : right;
  if (leftTime) return left;
  if (rightTime) return right;
  return left && (left.createdByLabel || left.createdById) ? left : right;
}

function dedupe(records, normalizer, sorter) {
  const merged = new Map();
  (Array.isArray(records) ? records : []).forEach((record, index) => {
    const normalized = normalizer(record, index);
    if (!normalized) return;
    const current = merged.get(normalized.id);
    if (!current) {
      merged.set(normalized.id, normalized);
      return;
    }
    const preferred = timeMs(normalized.updatedAt) >= timeMs(current.updatedAt) ? normalized : current;
    const created = earliestCreation(current, normalized) || preferred;
    merged.set(normalized.id, Object.assign({}, preferred, {
      createdAt: created.createdAt || preferred.createdAt || "",
      createdById: created.createdById || preferred.createdById || "",
      createdByType: created.createdByType || preferred.createdByType || "",
      createdByLabel: created.createdByLabel || preferred.createdByLabel || ""
    }));
  });
  return Array.from(merged.values()).sort(sorter);
}

function normalizeShopping(records) {
  return dedupe(records, (record, index) => {
    if (!record || !String(record.name || "").trim()) return null;
    return Object.assign({
      id: record.id ? String(record.id) : uid(),
      name: String(record.name).trim().slice(0, 80),
      bought: record.bought === true,
      boughtAt: record.boughtAt ? String(record.boughtAt) : null,
      order: Number.isFinite(Number(record.order)) ? Number(record.order) : index,
      deleted: record.deleted === true,
      updatedAt: String(record.updatedAt || record.boughtAt || "1970-01-01T00:00:00.000Z"),
      updatedById: String(record.updatedById || ""),
      updatedByType: String(record.updatedByType || ""),
      updatedByLabel: String(record.updatedByLabel || "")
    }, creationFields(record));
  }, (a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return timeMs(b.updatedAt) - timeMs(a.updatedAt);
  });
}

function normalizeEvents(records) {
  return dedupe(records, record => {
    if (!record || !String(record.title || "").trim() || !record.date) return null;
    return Object.assign({
      id: record.id ? String(record.id) : uid(),
      title: String(record.title).trim().slice(0, 100),
      date: String(record.date),
      endDate: String(record.endDate || record.date),
      allDay: record.allDay === true,
      startTime: String(record.startTime || ""),
      endTime: String(record.endTime || ""),
      note: String(record.note || "").trim().slice(0, 300),
      color: VALID_COLORS.has(record.color) ? record.color : "aqua",
      assignedTo: VALID_ASSIGNEES.has(record.assignedTo) ? record.assignedTo : "both",
      deleted: record.deleted === true,
      updatedAt: String(record.updatedAt || "1970-01-01T00:00:00.000Z"),
      updatedById: String(record.updatedById || ""),
      updatedByType: String(record.updatedByType || ""),
      updatedByLabel: String(record.updatedByLabel || "")
    }, creationFields(record));
  }, (a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (a.startTime || "99:99").localeCompare(b.startTime || "99:99");
  });
}

function normalizeTasks(records) {
  return dedupe(records, (record, index) => {
    if (!record || !String(record.title || "").trim()) return null;
    return Object.assign({
      id: record.id ? String(record.id) : uid(),
      title: String(record.title).trim().slice(0, 100),
      done: record.done === true,
      doneAt: record.doneAt ? String(record.doneAt) : null,
      dueDate: String(record.dueDate || ""),
      priority: VALID_PRIORITIES.has(record.priority) ? record.priority : "normal",
      assignedTo: VALID_ASSIGNEES.has(record.assignedTo) ? record.assignedTo : "both",
      order: Number.isFinite(Number(record.order)) ? Number(record.order) : index,
      deleted: record.deleted === true,
      updatedAt: String(record.updatedAt || record.doneAt || "1970-01-01T00:00:00.000Z"),
      updatedById: String(record.updatedById || ""),
      updatedByType: String(record.updatedByType || ""),
      updatedByLabel: String(record.updatedByLabel || "")
    }, creationFields(record));
  }, compareTasks);
}

function compareTasks(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const priorityRank = { high: 0, normal: 1, low: 2 };
  if (priorityRank[a.priority] !== priorityRank[b.priority]) {
    return priorityRank[a.priority] - priorityRank[b.priority];
  }
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate !== b.dueDate) return a.dueDate ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return timeMs(b.createdAt) - timeMs(a.createdAt);
}

function visibleShopping() {
  return state.shopping.filter(item => !item.deleted);
}

function visibleEvents() {
  return state.events.filter(item => !item.deleted);
}

function visibleTasks() {
  return state.tasks.filter(item => !item.deleted);
}

function persistAll() {
  state.shopping = normalizeShopping(state.shopping);
  state.events = normalizeEvents(state.events);
  state.tasks = normalizeTasks(state.tasks);
  saveJson(STORAGE.shopping, state.shopping);
  saveJson(STORAGE.events, state.events);
  saveJson(STORAGE.tasks, state.tasks);
}

function setUnsaved(value) {
  state.unsaved = Boolean(value);
  if (state.unsaved) localStorage.setItem(STORAGE.unsaved, "1");
  else localStorage.removeItem(STORAGE.unsaved);
}

function haptic(duration) {
  if (navigator.vibrate) navigator.vibrate(duration || 10);
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  state.toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2300);
}

function setStatus(kind, text) {
  const chip = $("#sync-chip");
  const label = $("#sync-text");
  if (!chip || !label) return;
  chip.classList.toggle("ok", kind === "ok");
  chip.classList.toggle("saving", kind === "saving");
  chip.classList.toggle("error", kind === "error");
  label.textContent = text;
}

function hasUnsupportedLocalData() {
  return state.events.length > 0 || state.tasks.length > 0;
}

function setIdleStatus() {
  if (state.connectionError) {
    setStatus("error", "Offline");
    return;
  }
  if (state.backendLimited && state.activeView !== "shopping") {
    setStatus("error", "Aktualizuj sync");
    return;
  }
  setStatus("ok", "Aktuálne");
}

function markDirty(delay) {
  state.revision += 1;
  setUnsaved(true);
  setStatus("saving", "Ukladám");
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => {
    state.syncTimer = null;
    syncToSheets(false);
  }, typeof delay === "number" ? delay : AUTO_SAVE_DELAY);
}

function parseRemote(data) {
  if (Array.isArray(data)) {
    return { shopping: normalizeShopping(data), events: null, tasks: null };
  }
  if (!data || data.ok === false) throw new Error(data && data.error ? data.error : "Neplatná odpoveď");
  return {
    shopping: Array.isArray(data.items) ? normalizeShopping(data.items) : null,
    events: Array.isArray(data.events) ? normalizeEvents(data.events) : null,
    tasks: Array.isArray(data.tasks) ? normalizeTasks(data.tasks) : null
  };
}

function readJsonResponse(response) {
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json().then(parseRemote);
}

function fetchRemote() {
  const attempts = [
    () => fetch(SHEETS_SYNC_URL + "?action=get&_=" + Date.now(), { method: "GET", cache: "no-store" }),
    () => fetch(SHEETS_SYNC_URL + "?action=load&_=" + Date.now(), { method: "GET", cache: "no-store" }),
    () => fetch(SHEETS_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "get" })
    })
  ];
  let index = 0;
  function next(lastError) {
    if (index >= attempts.length) return Promise.reject(lastError || new Error("Synchronizácia nie je dostupná"));
    const attempt = attempts[index++];
    return attempt().then(readJsonResponse).catch(next);
  }
  return next();
}

function mergeSnapshots(left, right) {
  return {
    shopping: normalizeShopping([...(left.shopping || []), ...(right.shopping || [])]),
    events: normalizeEvents([...(left.events || []), ...(right.events || [])]),
    tasks: normalizeTasks([...(left.tasks || []), ...(right.tasks || [])])
  };
}

function applyRemote(remote, requestRevision) {
  const changedDuringRequest = requestRevision !== state.revision;
  if (remote.shopping) {
    state.shopping = changedDuringRequest
      ? normalizeShopping([...remote.shopping, ...state.shopping])
      : remote.shopping;
  }
  if (remote.events) {
    state.events = changedDuringRequest
      ? normalizeEvents([...remote.events, ...state.events])
      : remote.events;
  }
  if (remote.tasks) {
    state.tasks = changedDuringRequest
      ? normalizeTasks([...remote.tasks, ...state.tasks])
      : remote.tasks;
  }
  persistAll();
  renderAll();
  return changedDuringRequest;
}

function postSnapshot(snapshot) {
  return fetch(SHEETS_SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "sync",
      items: snapshot.shopping,
      events: snapshot.events,
      tasks: snapshot.tasks
    })
  }).then(readJsonResponse);
}

function finishSync() {
  state.syncing = false;
  if (!state.syncQueued) return;
  state.syncQueued = false;
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => {
    state.syncTimer = null;
    syncToSheets(false);
  }, 300);
}

function syncToSheets(showFeedback) {
  if (state.syncing) {
    state.syncQueued = true;
    return Promise.resolve(false);
  }

  window.clearTimeout(state.syncTimer);
  state.syncTimer = null;
  const requestRevision = state.revision;
  const local = {
    shopping: normalizeShopping(state.shopping),
    events: normalizeEvents(state.events),
    tasks: normalizeTasks(state.tasks)
  };
  state.syncing = true;
  setStatus("saving", "Ukladám");

  return fetchRemote()
    .then(remote => postSnapshot(mergeSnapshots({
      shopping: remote.shopping || [],
      events: remote.events || [],
      tasks: remote.tasks || []
    }, local)))
    .then(finalRemote => {
      state.backendLimited = !finalRemote.events || !finalRemote.tasks;
      state.connectionError = false;
      const changed = applyRemote(finalRemote, requestRevision);
      state.lastSyncAt = Date.now();
      if (changed) {
        setUnsaved(true);
        setStatus("saving", "Ukladám");
        state.syncQueued = true;
      } else {
        setUnsaved(state.backendLimited && hasUnsupportedLocalData());
        setIdleStatus();
        if (showFeedback) showToast(state.backendLimited ? "Nákup je aktuálny." : "Všetko je aktuálne.");
      }
      return true;
    })
    .catch(error => {
      console.error(error);
      state.connectionError = true;
      setUnsaved(true);
      setIdleStatus();
      if (showFeedback) showToast("Nepodarilo sa pripojiť. Zmeny ostali uložené v zariadení.");
      return false;
    })
    .finally(finishSync);
}

function loadFromSheets(showFeedback) {
  if (state.unsaved) return syncToSheets(showFeedback);
  if (state.syncing) return Promise.resolve(false);
  const requestRevision = state.revision;
  state.syncing = true;
  setStatus("saving", "Načítavam");
  return fetchRemote()
    .then(remote => {
      state.backendLimited = !remote.events || !remote.tasks;
      state.connectionError = false;
      const changed = applyRemote(remote, requestRevision);
      state.lastSyncAt = Date.now();
      if (changed) {
        setUnsaved(true);
        setStatus("saving", "Ukladám");
        state.syncQueued = true;
      } else {
        setUnsaved(state.backendLimited && hasUnsupportedLocalData());
        setIdleStatus();
        if (showFeedback) showToast("Načítané.");
      }
      return true;
    })
    .catch(error => {
      console.error(error);
      state.connectionError = true;
      setIdleStatus();
      if (showFeedback) showToast("Momentálne sa nedá načítať zo Sheets.");
      return false;
    })
    .finally(finishSync);
}

function sourceParts(record) {
  const label = record.createdByLabel || record.updatedByLabel || "";
  const type = record.createdByType || record.updatedByType || "";
  const typeLabel = type === "mobile" ? "Mobil" : (type === "desktop" ? "PC" : "");
  const labelIsDevice = label && typeLabel && label.toLocaleLowerCase("sk-SK") === typeLabel.toLocaleLowerCase("sk-SK");
  return {
    author: labelIsDevice ? "Z " + typeLabel : (label ? "Od " + label : (typeLabel ? "Z " + typeLabel : "")),
    device: label && !labelIsDevice ? typeLabel : "",
    time: formatCreatedTime(record.createdAt || record.updatedAt)
  };
}

function assigneeDetails(record) {
  const value = VALID_ASSIGNEES.has(record && record.assignedTo) ? record.assignedTo : "both";
  if (value === "domi") return { value, label: "Domi" };
  if (value === "peto") return { value, label: "Peťo" };
  return { value: "both", label: "Obaja" };
}

function makeAssigneeBadge(record) {
  const person = assigneeDetails(record);
  if (person.value === "both") return null;
  const badge = document.createElement("span");
  badge.className = "assignee-badge " + person.value;
  badge.textContent = person.label;
  return badge;
}

function formatCreatedTime(value) {
  if (!timeMs(value)) return "";
  return new Date(value).toLocaleString("sk-SK", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDateLong(value) {
  return parseDateKey(value).toLocaleDateString("sk-SK", {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
}

function formatDue(value) {
  if (!value) return "";
  const today = dateKey(new Date());
  if (value === today) return "Dnes";
  if (value === dateKey(addDays(new Date(), 1))) return "Zajtra";
  return parseDateKey(value).toLocaleDateString("sk-SK", { day: "numeric", month: "short" });
}

function makeCheck() {
  const check = document.createElement("span");
  check.className = "check-box";
  check.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  return check;
}

function makeDelete(handler, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "delete-icon";
  button.setAttribute("aria-label", label || "Vymazať");
  button.innerHTML = '<span aria-hidden="true">&times;</span>';
  button.addEventListener("click", event => {
    event.stopPropagation();
    handler();
  });
  return button;
}

function makeEmpty(icon, title, description) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const iconBox = document.createElement("div");
  iconBox.className = "empty-icon";
  iconBox.innerHTML = icon;
  const strong = document.createElement("strong");
  strong.textContent = title;
  const text = document.createElement("span");
  text.textContent = description;
  empty.append(iconBox, strong, text);
  return empty;
}

function addListHeading(container, text, done) {
  const heading = document.createElement("div");
  heading.className = "list-heading" + (done ? " done" : "");
  heading.textContent = text;
  container.appendChild(heading);
}

function nextShoppingOrder() {
  const records = visibleShopping();
  return records.length ? Math.min(...records.map(item => item.order || 0)) - 1 : 0;
}

function rememberShoppingName(name) {
  const key = name.trim().toLocaleLowerCase("sk-SK");
  const current = state.history[key] || { name, count: 0 };
  current.name = name;
  current.count = Number(current.count || 0) + 1;
  current.usedAt = nowIso();
  state.history[key] = current;
  saveJson(STORAGE.history, state.history);
}

function shoppingSuggestions(query) {
  const value = query.trim().toLocaleLowerCase("sk-SK");
  if (!value) return [];
  const active = new Set(visibleShopping().map(item => item.name.toLocaleLowerCase("sk-SK")));
  return Object.values(state.history || {})
    .filter(item => item && item.name && item.name.toLocaleLowerCase("sk-SK").includes(value))
    .filter(item => !active.has(item.name.toLocaleLowerCase("sk-SK")))
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, 4);
}

function renderSuggestions() {
  const input = $("#shopping-input");
  const box = $("#shopping-suggestions");
  if (!input || !box) return;
  const values = shoppingSuggestions(input.value);
  box.innerHTML = "";
  box.hidden = values.length === 0;
  values.forEach(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-button";
    button.textContent = item.name;
    button.addEventListener("pointerdown", event => event.preventDefault());
    button.addEventListener("click", () => {
      input.value = item.name;
      box.hidden = true;
      input.focus();
    });
    box.appendChild(button);
  });
}

function addShopping(name) {
  const clean = String(name || "").trim().slice(0, 80);
  if (!clean) return false;
  const timestamp = nowIso();
  state.shopping.unshift(stamp({
    id: uid(),
    name: clean,
    bought: false,
    boughtAt: null,
    order: nextShoppingOrder(),
    deleted: false,
    createdAt: timestamp,
    createdById: device.id,
    createdByType: device.type,
    createdByLabel: device.label
  }, timestamp));
  rememberShoppingName(clean);
  persistAll();
  markDirty();
  renderShopping();
  haptic(10);
  return true;
}

function toggleShopping(id) {
  const item = state.shopping.find(record => record.id === id && !record.deleted);
  if (!item) return;
  const timestamp = nowIso();
  item.bought = !item.bought;
  item.boughtAt = item.bought ? timestamp : null;
  stamp(item, timestamp);
  persistAll();
  markDirty(450);
  renderShopping();
  haptic(item.bought ? 18 : 8);
}

function deleteShopping(id) {
  const item = state.shopping.find(record => record.id === id && !record.deleted);
  if (!item) return;
  item.deleted = true;
  stamp(item);
  persistAll();
  markDirty(400);
  renderShopping();
  haptic(8);
}

function markAllShopping() {
  const records = visibleShopping().filter(item => !item.bought);
  if (!records.length) return;
  const timestamp = nowIso();
  records.forEach(item => {
    item.bought = true;
    item.boughtAt = timestamp;
    stamp(item, timestamp);
  });
  persistAll();
  markDirty(400);
  renderShopping();
  haptic(18);
}

function clearBoughtShopping() {
  const records = visibleShopping().filter(item => item.bought);
  if (!records.length) return;
  const timestamp = nowIso();
  records.forEach(item => {
    item.deleted = true;
    stamp(item, timestamp);
  });
  persistAll();
  markDirty(400);
  renderShopping();
  haptic(12);
}

function activateShoppingDrag() {
  const drag = state.drag;
  if (!drag || drag.active || !drag.row.isConnected) return;
  const rect = drag.row.getBoundingClientRect();
  const ghost = drag.row.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.left = rect.left + "px";
  ghost.style.top = rect.top + "px";
  ghost.style.width = rect.width + "px";
  ghost.style.height = rect.height + "px";
  document.body.appendChild(ghost);
  drag.active = true;
  drag.ghost = ghost;
  drag.offsetY = drag.startY - rect.top;
  drag.row.classList.add("drag-placeholder");
  document.body.classList.add("item-dragging");
  haptic(28);
}

function beginShoppingHold(row, item, point, kind, pointerId) {
  if (state.drag) cancelShoppingDrag(false);
  state.drag = {
    row,
    item,
    kind,
    pointerId,
    startX: point.clientX,
    startY: point.clientY,
    lastX: point.clientX,
    lastY: point.clientY,
    active: false,
    timer: window.setTimeout(activateShoppingDrag, kind === "touch" ? 430 : 300),
    ghost: null
  };
}

function moveShoppingDrag(clientX, clientY) {
  const drag = state.drag;
  if (!drag) return false;
  drag.lastX = clientX;
  drag.lastY = clientY;
  if (!drag.active) {
    if (Math.hypot(clientX - drag.startX, clientY - drag.startY) > 11) {
      cancelShoppingDrag(false);
    }
    return false;
  }

  drag.ghost.style.top = (clientY - drag.offsetY) + "px";
  const target = document.elementFromPoint(clientX, clientY);
  const targetRow = target && target.closest ? target.closest(".item-row") : null;
  if (targetRow && targetRow !== drag.row && targetRow.dataset.bought === drag.row.dataset.bought) {
    const rect = targetRow.getBoundingClientRect();
    const after = clientY > rect.top + rect.height / 2;
    targetRow.parentNode.insertBefore(drag.row, after ? targetRow.nextSibling : targetRow);
  }

  const edge = 82;
  if (clientY < edge) window.scrollBy(0, -8);
  else if (clientY > window.innerHeight - edge) window.scrollBy(0, 8);
  return true;
}

function saveShoppingOrderFromDom() {
  const timestamp = nowIso();
  let changed = false;
  ["0", "1"].forEach(status => {
    const rows = Array.from(document.querySelectorAll('.item-row[data-bought="' + status + '"]'));
    rows.forEach((row, index) => {
      const item = state.shopping.find(record => record.id === row.dataset.id && !record.deleted);
      if (item && item.order !== index) {
        item.order = index;
        stamp(item, timestamp);
        changed = true;
      }
    });
  });
  if (changed) {
    persistAll();
    markDirty(450);
  }
}

function cancelShoppingDrag(saveOrder) {
  const drag = state.drag;
  if (!drag) return;
  window.clearTimeout(drag.timer);
  if (drag.active) {
    if (saveOrder) saveShoppingOrderFromDom();
    state.suppressItemClickUntil = Date.now() + 550;
    drag.row.classList.remove("drag-placeholder");
    if (drag.ghost) drag.ghost.remove();
    document.body.classList.remove("item-dragging");
    haptic(saveOrder ? 18 : 7);
  }
  state.drag = null;
  if (saveOrder) renderShopping();
}

function touchById(touches, id) {
  return Array.from(touches || []).find(touch => touch.identifier === id) || null;
}

function renderShoppingRow(item) {
  const row = document.createElement("article");
  row.className = "item-row" + (item.bought ? " completed" : "");
  row.dataset.id = item.id;
  row.dataset.bought = item.bought ? "1" : "0";
  row.appendChild(makeCheck());
  const copy = document.createElement("div");
  copy.className = "item-copy";
  const name = document.createElement("div");
  name.className = "item-name";
  name.textContent = item.name;
  const source = sourceParts(item);
  const meta = document.createElement("div");
  meta.className = "item-meta";
  [source.author, source.device, source.time].filter(Boolean).forEach((value, index) => {
    const span = document.createElement("span");
    if (index === 0) span.className = "meta-author";
    span.textContent = value;
    meta.appendChild(span);
  });
  copy.append(name, meta);
  row.append(copy, makeDelete(() => deleteShopping(item.id), "Vymazať " + item.name));
  row.addEventListener("click", event => {
    if (Date.now() < state.suppressItemClickUntil) return;
    if (!event.target.closest("button")) toggleShopping(item.id);
  });
  row.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch" || event.button !== 0 || event.target.closest("button")) return;
    beginShoppingHold(row, item, event, "pointer", event.pointerId);
  });
  row.addEventListener("touchstart", event => {
    if (event.target.closest("button")) return;
    const touch = event.changedTouches && event.changedTouches[0];
    if (touch) beginShoppingHold(row, item, touch, "touch", touch.identifier);
  }, { passive: true });
  row.addEventListener("contextmenu", event => event.preventDefault());
  return row;
}

function renderShopping() {
  const list = $("#shopping-list");
  if (!list) return;
  if (state.drag) return;
  list.innerHTML = "";
  const records = visibleShopping();
  const open = records.filter(item => !item.bought);
  const done = records.filter(item => item.bought);
  $("#mark-all-shopping").disabled = open.length === 0;
  $("#clear-shopping").disabled = done.length === 0;
  if (!records.length) {
    list.appendChild(makeEmpty(
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2 10h10l2-7H6M9 20h.01M17 20h.01"/></svg>',
      "Zoznam čaká na prvú položku",
      "Napíš ju hore a potvrď Enterom."
    ));
    return;
  }
  if (open.length) {
    addListHeading(list, "Kúpiť", false);
    open.forEach(item => list.appendChild(renderShoppingRow(item)));
  }
  if (done.length) {
    addListHeading(list, "Kúpené", true);
    done.forEach(item => list.appendChild(renderShoppingRow(item)));
  }
}

function eventsOnDate(value) {
  return visibleEvents().filter(event => event.date <= value && (event.endDate || event.date) >= value);
}

function renderCalendar() {
  const grid = $("#calendar-grid");
  if (!grid) return;
  grid.innerHTML = "";
  $("#calendar-month").textContent = state.calendarCursor.toLocaleDateString("sk-SK", {
    month: "long",
    year: "numeric"
  });
  const first = startOfMonth(state.calendarCursor);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = addDays(first, -mondayOffset);
  const today = dateKey(new Date());

  for (let index = 0; index < 42; index += 1) {
    const date = addDays(start, index);
    const key = dateKey(date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    if (date.getMonth() !== first.getMonth()) button.classList.add("outside");
    if (key === today) button.classList.add("today");
    if (key === state.selectedDate) button.classList.add("selected");
    button.setAttribute("aria-label", formatDateLong(key));
    const number = document.createElement("span");
    number.textContent = String(date.getDate());
    const dots = document.createElement("span");
    dots.className = "day-dots";
    eventsOnDate(key).slice(0, 3).forEach(event => {
      const dot = document.createElement("i");
      dot.className = "day-dot " + event.color;
      dots.appendChild(dot);
    });
    button.append(number, dots);
    button.addEventListener("click", () => {
      state.selectedDate = key;
      if (date.getMonth() !== state.calendarCursor.getMonth() || date.getFullYear() !== state.calendarCursor.getFullYear()) {
        state.calendarCursor = startOfMonth(date);
      }
      renderCalendar();
    });
    grid.appendChild(button);
  }
  renderToday();
  renderAgenda();
  renderUpcoming();
}

function renderAgendaRow(item) {
  const row = document.createElement("article");
  row.className = "agenda-item";
  row.dataset.color = item.color;
  const time = document.createElement("div");
  time.className = "event-time" + (item.allDay ? " all-day" : "");
  time.textContent = item.allDay ? "Celý deň" : (item.startTime || "Čas?");
  const copy = document.createElement("div");
  copy.className = "event-copy";
  const titleLine = document.createElement("div");
  titleLine.className = "event-title-line";
  const title = document.createElement("div");
  title.className = "event-title";
  title.textContent = item.title;
  titleLine.appendChild(title);
  const assignee = makeAssigneeBadge(item);
  if (assignee) titleLine.appendChild(assignee);
  copy.appendChild(titleLine);
  if (item.note) {
    const note = document.createElement("div");
    note.className = "event-note";
    note.textContent = item.note;
    copy.appendChild(note);
  }
  const source = sourceParts(item);
  const author = document.createElement("div");
  author.className = "event-author";
  author.textContent = [source.author, source.time].filter(Boolean).join(" · ");
  copy.appendChild(author);
  const edit = document.createElement("span");
  edit.className = "agenda-edit";
  edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-1 5 5-1L19 9l-4-4L4 16ZM13 7l4 4"/></svg>';
  row.append(time, copy, edit);
  row.addEventListener("click", () => openEventSheet(item));
  return row;
}

function renderToday() {
  const list = $("#today-list");
  if (!list) return;
  const today = dateKey(new Date());
  list.innerHTML = "";
  $("#today-date-label").textContent = formatDateLong(today);
  const records = eventsOnDate(today);
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "today-empty";
    empty.innerHTML = '<span>Voľný deň</span><small>Zatiaľ nemáte nič naplánované.</small>';
    list.appendChild(empty);
    return;
  }
  records.forEach(item => list.appendChild(renderAgendaRow(item)));
}

function renderAgenda() {
  const list = $("#agenda-list");
  if (!list) return;
  list.innerHTML = "";
  const today = dateKey(new Date());
  const section = $("#selected-agenda-section");
  const isToday = state.selectedDate === today;
  section.hidden = isToday;
  if (isToday) return;
  $("#selected-date-title").textContent = formatDateLong(state.selectedDate);
  const records = eventsOnDate(state.selectedDate);
  if (!records.length) {
    list.appendChild(makeEmpty(
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
      "Tento deň je voľný",
      "Pridajte si spoločnú udalosť."
    ));
    return;
  }
  records.forEach(item => list.appendChild(renderAgendaRow(item)));
}

function renderUpcoming() {
  const list = $("#upcoming-list");
  if (!list) return;
  list.innerHTML = "";
  const today = dateKey(new Date());
  const records = visibleEvents()
    .filter(item => item.date > today)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return (a.startTime || "99:99").localeCompare(b.startTime || "99:99");
    })
    .slice(0, 14);
  const count = $("#upcoming-count");
  count.textContent = records.length === 1 ? "1 udalosť" : records.length + " udalostí";
  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "upcoming-empty";
    empty.textContent = "Zatiaľ vás nečaká nič naplánované.";
    list.appendChild(empty);
    return;
  }
  records.forEach(item => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "upcoming-item";
    row.dataset.color = item.color;
    const date = parseDateKey(item.date);
    const badge = document.createElement("span");
    badge.className = "upcoming-date";
    badge.textContent = String(date.getDate());
    const month = document.createElement("small");
    month.textContent = date.toLocaleDateString("sk-SK", { month: "short" }).replace(".", "");
    badge.appendChild(month);
    const copy = document.createElement("span");
    copy.className = "upcoming-copy";
    const titleLine = document.createElement("span");
    titleLine.className = "upcoming-title-line";
    const title = document.createElement("span");
    title.className = "upcoming-title";
    title.textContent = item.title;
    titleLine.appendChild(title);
    const assignee = makeAssigneeBadge(item);
    if (assignee) titleLine.appendChild(assignee);
    const meta = document.createElement("span");
    meta.className = "upcoming-meta";
    const time = item.allDay ? "Celý deň" : (item.startTime || "Bez času");
    meta.textContent = [date.toLocaleDateString("sk-SK", { weekday: "long" }), time].join(" · ");
    copy.append(titleLine, meta);
    const chevron = document.createElement("span");
    chevron.className = "upcoming-chevron";
    chevron.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
    row.append(badge, copy, chevron);
    row.addEventListener("click", () => openEventSheet(item));
    list.appendChild(row);
  });
}

function openEventSheet(item, dateOverride) {
  const editing = Boolean(item);
  $("#event-sheet-title").textContent = editing ? "Upraviť udalosť" : "Nová udalosť";
  $("#event-id").value = editing ? item.id : "";
  $("#event-title").value = editing ? item.title : "";
  $("#event-date").value = editing ? item.date : (dateOverride || state.selectedDate);
  $("#event-all-day").checked = editing ? item.allDay : false;
  $("#event-start").value = editing ? item.startTime : "09:00";
  $("#event-end").value = editing ? item.endTime : "10:00";
  $("#event-note").value = editing ? item.note : "";
  const color = editing ? item.color : "aqua";
  const radio = document.querySelector('input[name="event-color"][value="' + color + '"]');
  if (radio) radio.checked = true;
  const assignedTo = editing && VALID_ASSIGNEES.has(item.assignedTo) ? item.assignedTo : "both";
  const assigneeRadio = document.querySelector('input[name="event-assignee"][value="' + assignedTo + '"]');
  if (assigneeRadio) assigneeRadio.checked = true;
  $("#delete-event").hidden = !editing;
  updateAllDayFields();
  openSheet("event");
  window.setTimeout(() => $("#event-title").focus(), 280);
}

function saveEventFromForm() {
  const title = $("#event-title").value.trim();
  const date = $("#event-date").value;
  if (!title || !date) return false;
  const id = $("#event-id").value;
  const timestamp = nowIso();
  const existing = id ? state.events.find(event => event.id === id && !event.deleted) : null;
  const colorInput = document.querySelector('input[name="event-color"]:checked');
  const assigneeInput = document.querySelector('input[name="event-assignee"]:checked');
  const values = {
    title,
    date,
    endDate: date,
    allDay: $("#event-all-day").checked,
    startTime: $("#event-all-day").checked ? "" : $("#event-start").value,
    endTime: $("#event-all-day").checked ? "" : $("#event-end").value,
    note: $("#event-note").value.trim(),
    color: colorInput ? colorInput.value : "aqua",
    assignedTo: assigneeInput && VALID_ASSIGNEES.has(assigneeInput.value) ? assigneeInput.value : "both",
    deleted: false
  };
  if (existing) {
    Object.assign(existing, values);
    stamp(existing, timestamp);
  } else {
    state.events.push(stamp(Object.assign({
      id: uid(),
      createdAt: timestamp,
      createdById: device.id,
      createdByType: device.type,
      createdByLabel: device.label
    }, values), timestamp));
  }
  state.selectedDate = date;
  state.calendarCursor = startOfMonth(parseDateKey(date));
  persistAll();
  markDirty(500);
  renderCalendar();
  closeSheet("event");
  haptic(14);
  showToast(existing ? "Udalosť upravená." : "Udalosť pridaná.");
  return true;
}

function deleteCurrentEvent() {
  const id = $("#event-id").value;
  const event = state.events.find(item => item.id === id && !item.deleted);
  if (!event) return;
  event.deleted = true;
  stamp(event);
  persistAll();
  markDirty(400);
  renderCalendar();
  closeSheet("event");
  haptic(9);
}

function updateAllDayFields() {
  $("#event-time-fields").classList.toggle("hidden", $("#event-all-day").checked);
}

function nextTaskOrder() {
  const records = visibleTasks();
  return records.length ? Math.min(...records.map(item => item.order || 0)) - 1 : 0;
}

function addTask(title, dueDate, priority, assignedTo) {
  const clean = String(title || "").trim().slice(0, 100);
  if (!clean) return false;
  const timestamp = nowIso();
  state.tasks.unshift(stamp({
    id: uid(),
    title: clean,
    done: false,
    doneAt: null,
    dueDate: dueDate || "",
    priority: VALID_PRIORITIES.has(priority) ? priority : "normal",
    assignedTo: VALID_ASSIGNEES.has(assignedTo) ? assignedTo : "both",
    order: nextTaskOrder(),
    deleted: false,
    createdAt: timestamp,
    createdById: device.id,
    createdByType: device.type,
    createdByLabel: device.label
  }, timestamp));
  persistAll();
  markDirty();
  renderTasks();
  haptic(10);
  return true;
}

function toggleTask(id) {
  const item = state.tasks.find(record => record.id === id && !record.deleted);
  if (!item) return;
  const timestamp = nowIso();
  item.done = !item.done;
  item.doneAt = item.done ? timestamp : null;
  stamp(item, timestamp);
  persistAll();
  markDirty(450);
  renderTasks();
  haptic(item.done ? 18 : 8);
}

function deleteTask(id) {
  const item = state.tasks.find(record => record.id === id && !record.deleted);
  if (!item) return;
  item.deleted = true;
  stamp(item);
  persistAll();
  markDirty(400);
  renderTasks();
  haptic(8);
}

function clearDoneTasks() {
  const records = visibleTasks().filter(item => item.done);
  if (!records.length) return;
  const timestamp = nowIso();
  records.forEach(item => {
    item.deleted = true;
    stamp(item, timestamp);
  });
  persistAll();
  markDirty(400);
  renderTasks();
  haptic(12);
}

function renderTaskRow(item) {
  const row = document.createElement("article");
  row.className = "task-row " + item.priority + (item.done ? " completed" : "");
  const bar = document.createElement("span");
  bar.className = "priority-bar";
  row.append(bar, makeCheck());
  const copy = document.createElement("div");
  copy.className = "task-copy";
  const name = document.createElement("div");
  name.className = "task-name";
  name.textContent = item.title;
  const meta = document.createElement("div");
  meta.className = "task-meta";
  if (item.dueDate) {
    const due = document.createElement("span");
    due.className = "due-chip" + (!item.done && item.dueDate < dateKey(new Date()) ? " overdue" : "");
    due.textContent = formatDue(item.dueDate);
    meta.appendChild(due);
  }
  const assignee = makeAssigneeBadge(item);
  if (assignee) meta.appendChild(assignee);
  const source = sourceParts(item);
  const author = document.createElement("span");
  author.className = "meta-author";
  author.textContent = [source.author, source.time].filter(Boolean).join(" · ");
  meta.appendChild(author);
  copy.append(name, meta);
  row.append(copy, makeDelete(() => deleteTask(item.id), "Vymazať " + item.title));
  row.addEventListener("click", event => {
    if (!event.target.closest("button")) toggleTask(item.id);
  });
  return row;
}

function renderTasks() {
  const list = $("#task-list");
  if (!list) return;
  list.innerHTML = "";
  const records = visibleTasks();
  const open = records.filter(item => !item.done).sort(compareTasks);
  const done = records.filter(item => item.done).sort(compareTasks);
  $("#clear-tasks").disabled = done.length === 0;
  if (!records.length) {
    list.appendChild(makeEmpty(
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 7 2 2 4-4M12 7h8M4 14l2 2 4-4M12 14h8"/></svg>',
      "Žiadne otvorené úlohy",
      "Keď niečo treba vybaviť, napíšte to sem."
    ));
    return;
  }
  if (open.length) {
    addListHeading(list, "Treba vybaviť", false);
    open.forEach(item => list.appendChild(renderTaskRow(item)));
  }
  if (done.length) {
    addListHeading(list, "Hotové", true);
    done.forEach(item => list.appendChild(renderTaskRow(item)));
  }
}

function renderAll() {
  renderShopping();
  renderCalendar();
  renderTasks();
  updateDeviceUi();
}

function switchView(target) {
  if (!["shopping", "calendar", "tasks"].includes(target)) return;
  state.activeView = target;
  localStorage.setItem(STORAGE.activeView, target);
  $$(".view").forEach(view => {
    const active = view.dataset.view === target;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.target === target));
  const titles = { shopping: "Nákup", calendar: "Kalendár", tasks: "Úlohy" };
  $("#section-title").textContent = titles[target];
  if (target === "calendar") renderCalendar();
  if (!state.syncing) setIdleStatus();
  window.scrollTo({ top: 0, behavior: "smooth" });
  haptic(6);
}

function openSheet(name) {
  const sheet = $("#" + name + "-sheet");
  const backdrop = $("#" + name + "-backdrop");
  if (!sheet || !backdrop) return;
  backdrop.hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    backdrop.classList.add("open");
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
  });
}

function closeSheet(name) {
  const sheet = $("#" + name + "-sheet");
  const backdrop = $("#" + name + "-backdrop");
  if (!sheet || !backdrop) return;
  sheet.classList.remove("open");
  backdrop.classList.remove("open");
  sheet.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    backdrop.hidden = true;
    if (!document.querySelector(".bottom-sheet.open")) document.body.classList.remove("modal-open");
  }, 270);
}

function updateDeviceUi() {
  const settingsButton = $("#open-settings");
  settingsButton.setAttribute("aria-label", "Nastavenia zariadenia " + (device.label || ""));
  $("#device-name").value = device.label;
}

function saveDeviceName() {
  const value = $("#device-name").value.trim().slice(0, 24);
  if (!value) {
    showToast("Napíš meno Domi alebo Peťo.");
    return;
  }
  device.label = value;
  saveJson(STORAGE.device, device);
  updateDeviceUi();
  closeSheet("settings");
  showToast("Toto zariadenie je teraz " + value + ".");
}

function bindPullToRefresh() {
  document.addEventListener("touchstart", event => {
    if (state.syncing || window.scrollY > 0 || event.target.closest("input, textarea, select, button, .bottom-sheet, .item-row")) return;
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    state.pull = { startY: touch.clientY, distance: 0 };
  }, { passive: true });

  document.addEventListener("touchmove", event => {
    if (!state.pull) return;
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    const delta = touch.clientY - state.pull.startY;
    if (delta <= 0 || window.scrollY > 0) {
      state.pull = null;
      $("#pull-indicator").classList.remove("visible");
      return;
    }
    state.pull.distance = Math.min(110, delta * 0.55);
    const indicator = $("#pull-indicator");
    indicator.classList.add("visible");
    indicator.textContent = state.pull.distance >= PULL_THRESHOLD ? "Pusti pre obnovenie" : "Potiahni ešte trochu";
    if (delta > 18) event.preventDefault();
  }, { passive: false });

  document.addEventListener("touchend", () => {
    if (!state.pull) return;
    const refresh = state.pull.distance >= PULL_THRESHOLD;
    state.pull = null;
    const indicator = $("#pull-indicator");
    if (refresh) {
      indicator.textContent = "Načítavam...";
      loadFromSheets(true).finally(() => indicator.classList.remove("visible"));
    } else {
      indicator.classList.remove("visible");
    }
  }, { passive: true });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  navigator.serviceWorker.register("./service-worker.js")
    .then(registration => registration.update())
    .catch(error => console.error(error));
}

function submitShoppingComposer() {
  const input = $("#shopping-input");
  if (!input) return;
  if (addShopping(input.value)) {
    input.value = "";
    $("#shopping-suggestions").hidden = true;
    input.focus({ preventScroll: true });
  }
}

function submitTaskComposer() {
  const input = $("#task-input");
  if (!input) return;
  if (addTask(input.value, "", $("#task-priority").value, $("#task-assignee").value)) {
    input.value = "";
    $("#task-assignee").value = "both";
    input.focus({ preventScroll: true });
  }
}

function bindEvents() {
  document.addEventListener("pointermove", event => {
    if (!state.drag || state.drag.kind !== "pointer" || state.drag.pointerId !== event.pointerId) return;
    if (moveShoppingDrag(event.clientX, event.clientY)) event.preventDefault();
  }, { passive: false });
  document.addEventListener("pointerup", event => {
    if (state.drag && state.drag.kind === "pointer" && state.drag.pointerId === event.pointerId) {
      cancelShoppingDrag(state.drag.active);
    }
  });
  document.addEventListener("pointercancel", event => {
    if (state.drag && state.drag.kind === "pointer" && state.drag.pointerId === event.pointerId) {
      cancelShoppingDrag(false);
    }
  });
  document.addEventListener("touchmove", event => {
    if (!state.drag || state.drag.kind !== "touch") return;
    const touch = touchById(event.touches, state.drag.pointerId);
    if (!touch) return;
    if (moveShoppingDrag(touch.clientX, touch.clientY)) event.preventDefault();
  }, { passive: false });
  document.addEventListener("touchend", event => {
    if (!state.drag || state.drag.kind !== "touch") return;
    if (touchById(event.changedTouches, state.drag.pointerId)) cancelShoppingDrag(state.drag.active);
  }, { passive: true });
  document.addEventListener("touchcancel", event => {
    if (!state.drag || state.drag.kind !== "touch") return;
    if (touchById(event.changedTouches, state.drag.pointerId)) cancelShoppingDrag(false);
  }, { passive: true });

  $$(".nav-item").forEach(button => button.addEventListener("click", () => switchView(button.dataset.target)));
  $("#shopping-form").addEventListener("submit", event => {
    event.preventDefault();
    submitShoppingComposer();
  });
  $("#shopping-input").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    submitShoppingComposer();
  });
  $("#shopping-input").addEventListener("input", renderSuggestions);
  $("#shopping-input").addEventListener("focus", renderSuggestions);
  $("#shopping-input").addEventListener("blur", () => window.setTimeout(() => $("#shopping-suggestions").hidden = true, 120));
  $("#mark-all-shopping").addEventListener("click", markAllShopping);
  $("#clear-shopping").addEventListener("click", clearBoughtShopping);

  $("#calendar-prev").addEventListener("click", () => {
    state.calendarCursor = addMonths(state.calendarCursor, -1);
    renderCalendar();
  });
  $("#calendar-next").addEventListener("click", () => {
    state.calendarCursor = addMonths(state.calendarCursor, 1);
    renderCalendar();
  });
  $("#calendar-today").addEventListener("click", () => {
    const today = new Date();
    state.selectedDate = dateKey(today);
    state.calendarCursor = startOfMonth(today);
    renderCalendar();
  });
  $("#add-today-event").addEventListener("click", () => openEventSheet(null, dateKey(new Date())));
  $("#add-event").addEventListener("click", () => openEventSheet(null));
  $("#close-event").addEventListener("click", () => closeSheet("event"));
  $("#event-backdrop").addEventListener("click", () => closeSheet("event"));
  $("#event-all-day").addEventListener("change", updateAllDayFields);
  $("#event-form").addEventListener("submit", event => {
    event.preventDefault();
    saveEventFromForm();
  });
  $("#delete-event").addEventListener("click", deleteCurrentEvent);

  $("#task-form").addEventListener("submit", event => {
    event.preventDefault();
    submitTaskComposer();
  });
  $("#task-input").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    submitTaskComposer();
  });
  $("#clear-tasks").addEventListener("click", clearDoneTasks);

  $("#open-settings").addEventListener("click", () => openSheet("settings"));
  $("#close-settings").addEventListener("click", () => closeSheet("settings"));
  $("#settings-backdrop").addEventListener("click", () => closeSheet("settings"));
  $("#save-device").addEventListener("click", saveDeviceName);
  $$("[data-person]").forEach(button => button.addEventListener("click", () => {
    $("#device-name").value = button.dataset.person;
  }));
  $("#sync-now").addEventListener("click", () => {
    closeSheet("settings");
    state.unsaved ? syncToSheets(true) : loadFromSheets(true);
  });
  $("#sync-chip").addEventListener("click", () => state.unsaved ? syncToSheets(true) : loadFromSheets(true));

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if ($("#event-sheet").classList.contains("open")) closeSheet("event");
    else if ($("#settings-sheet").classList.contains("open")) closeSheet("settings");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - state.lastSyncAt > FOREGROUND_SYNC_GAP) {
      state.unsaved ? syncToSheets(false) : loadFromSheets(false);
    }
  });
  window.addEventListener("online", () => state.unsaved ? syncToSheets(false) : loadFromSheets(false));
}

function boot() {
  state.shopping = normalizeShopping(loadJson(STORAGE.shopping, []));
  state.events = normalizeEvents(loadJson(STORAGE.events, []));
  state.tasks = normalizeTasks(loadJson(STORAGE.tasks, []));
  persistAll();
  bindEvents();
  bindPullToRefresh();
  switchView(state.activeView);
  renderAll();
  updateDeviceUi();
  registerServiceWorker();
  if (state.unsaved) syncToSheets(false);
  else loadFromSheets(false);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
