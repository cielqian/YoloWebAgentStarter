/* eslint-env browser */
(function () {
  "use strict";

  var REFRESH_MS = 15000;
  var STATUS_LABEL = {
    pending: "等待中",
    dispatching: "下发中",
    running: "训练中",
    completed: "已完成",
    failed: "已失败",
    stopped: "已停止",
  };
  var TASK_TYPE_LABEL = {
    detect: "检测",
    segment: "分割",
    obb: "旋转框",
    classify: "分类",
    pose: "姿态",
  };

  // 1. 解析宿主注入的 __ctx(base64 JSON): { apiBase, pluginId }
  var context = {};
  try {
    context = JSON.parse(atob(new URLSearchParams(location.search).get("__ctx") || ""));
  } catch (error) { context = {}; }
  var apiBase = context.apiBase || "";

  function api(path, options) {
    return fetch(apiBase + path, options).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  var el = {
    meta: document.getElementById("meta"),
    cards: document.getElementById("cards"),
    rows: document.getElementById("rows"),
    state: document.getElementById("state"),
    refresh: document.getElementById("refresh"),
    auto: document.getElementById("auto-refresh"),
  };
  el.meta.textContent =
    "v1.0.0 · apiBase: " + (apiBase || "(未注入，使用同源)") + " · pluginId: " + (context.pluginId || "-");

  function formatTime(value) {
    if (!value) return "-";
    var date = new Date(value);
    return isNaN(date.getTime())
      ? "-"
      : date.toLocaleString("zh-CN", { hour12: false });
  }

  function formatMetric(value) {
    return typeof value === "number" && isFinite(value) ? value.toFixed(4) : "-";
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderSummary(items) {
    var count = function (status) {
      return items.filter(function (task) { return task.status === status; }).length;
    };
    var specs = [
      { label: "任务总数", value: items.length, tone: "" },
      { label: "训练中", value: count("running"), tone: "ok" },
      { label: "等待/下发中", value: count("pending") + count("dispatching"), tone: "warn" },
      { label: "已完成", value: count("completed"), tone: "ok" },
      { label: "失败/停止", value: count("failed") + count("stopped"), tone: "err" },
    ];
    el.cards.innerHTML = specs.map(function (spec) {
      return (
        '<div class="card"><small>' + escapeHtml(spec.label) + "</small>" +
        '<strong class="' + spec.tone + '">' + spec.value + "</strong></div>"
      );
    }).join("");
  }

  function renderRow(task) {
    var metrics = task.metrics_json || {};
    var percent = Math.max(0, Math.min(100, Number(task.progress_percent) || 0));
    var status = STATUS_LABEL[task.status] || task.status;
    var type = TASK_TYPE_LABEL[task.task_type] || task.task_type || "-";
    return (
      "<tr>" +
      '<td class="task-cell"><strong>' + escapeHtml(task.name || task.id) + "</strong>" +
      (task.error_message
        ? '<small class="err-cell" title="' + escapeHtml(task.error_message) + '">' + escapeHtml(task.error_message) + "</small>"
        : '<small class="muted">' + escapeHtml(task.id) + "</small>") +
      "</td>" +
      '<td><span class="badge ' + escapeHtml(task.status) + '">' + escapeHtml(status) + "</span></td>" +
      "<td>" + escapeHtml(type) + ' <span class="muted">' + escapeHtml(task.model_name || "-") + "</span></td>" +
      "<td>" + escapeHtml(task.device || "-") +
      (task.node_id ? ' <span class="muted">@ ' + escapeHtml(task.node_id) + "</span>" : "") +
      "</td>" +
      '<td class="num"><div class="bar">' +
      '<span>' + (task.progress_epoch || 0) + "/" + (task.progress_total_epochs || task.epochs || 0) + "</span>" +
      '<div class="bar-track"><div class="bar-fill" style="width:' + percent.toFixed(1) + '%"></div></div>' +
      "</div></td>" +
      '<td class="num">' + escapeHtml(formatMetric(metrics.map50)) + "</td>" +
      '<td class="num">' + escapeHtml(formatMetric(metrics.map50_95)) + "</td>" +
      '<td class="num">' + escapeHtml(formatMetric(metrics.loss)) + "</td>" +
      '<td class="muted">' + escapeHtml(formatTime(task.updated_at)) + "</td>" +
      "</tr>"
    );
  }

  function showState(text, isError) {
    el.rows.innerHTML = "";
    el.state.hidden = false;
    el.state.textContent = text;
    el.state.className = isError ? "state error" : "state";
  }

  var loading = false;

  function load() {
    if (loading) return;
    loading = true;
    return api("/api/training/tasks")
      .then(function (data) {
        var items = (data && data.items) || [];
        if (!items.length) {
          renderSummary(items);
          showState("暂无训练任务，去平台创建一个吧。");
          return;
        }
        renderSummary(items);
        el.state.hidden = true;
        el.rows.innerHTML = items.map(renderRow).join("");
      })
      .catch(function (error) {
        showState("加载失败：" + error.message + "（请检查 apiBase 与平台服务是否可达）", true);
      })
      .then(function () { loading = false; });
  }

  el.refresh.addEventListener("click", load);

  var timer = null;
  function syncAutoRefresh() {
    if (timer) { clearInterval(timer); timer = null; }
    if (el.auto.checked) timer = setInterval(load, REFRESH_MS);
  }
  el.auto.addEventListener("change", syncAutoRefresh);

  syncAutoRefresh();
  load();
})();
