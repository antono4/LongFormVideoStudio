const $ = (id) => document.getElementById(id);
const form = $("gen-form");
const submitBtn = $("submit-btn");
const durationInput = $("duration");
const durValue = $("dur-value");

let pollTimer = null;

durationInput.addEventListener("input", () => {
  durValue.textContent = durationInput.value;
});

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function showProgress() {
  hide($("placeholder"));
  hide($("video-box"));
  hide($("error-box"));
  show($("progress-box"));
}

function showError(message) {
  hide($("progress-box"));
  hide($("video-box"));
  $("error-text").textContent = message;
  show($("error-box"));
}

function showVideo(job) {
  hide($("progress-box"));
  hide($("placeholder"));
  hide($("error-box"));
  $("video-title").textContent = job.title || job.topic;
  const r = job.result || {};
  $("video-meta").textContent =
    `${r.duration ? r.duration.toFixed(1) : "?"}s  •  ` +
    `${r.scene_durations ? r.scene_durations.length : "?"} scenes  •  ` +
    `${r.size ? (r.size / 1048576).toFixed(1) + " MB" : ""}`;
  $("video").src = `/video/${job.id}`;
  $("download-btn").href = `/download/${job.id}`;
  show($("video-box"));
}

function updateProgress(job) {
  $("stage").textContent = job.stage || "Working...";
  $("bar-fill").style.width = (job.progress || 0) + "%";
  $("pct").textContent = (job.progress || 0) + "%";
}

async function poll(jobId) {
  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    const job = await res.json();
    if (job.status === "done") {
      updateProgress(job);
      clearInterval(pollTimer);
      submitBtn.disabled = false;
      showVideo(job);
      loadHistory();
    } else if (job.status === "error") {
      clearInterval(pollTimer);
      submitBtn.disabled = false;
      showError(job.error || "Generation failed.");
    } else {
      updateProgress(job);
    }
  } catch (e) {
    clearInterval(pollTimer);
    submitBtn.disabled = false;
    showError("Lost connection to the server.");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    topic: $("topic").value.trim(),
    duration: parseInt(durationInput.value, 10),
    voice: $("voice").value,
    style: $("style").value,
    tone: $("tone").value.trim(),
    motion: $("motion").value,
  };
  if (!payload.topic) return;

  submitBtn.disabled = true;
  showProgress();
  updateProgress({ stage: "Submitting request...", progress: 2 });

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const job = await res.json();
    if (!res.ok) {
      submitBtn.disabled = false;
      showError(job.error || "Request failed.");
      return;
    }
    pollTimer = setInterval(() => poll(job.id), 1500);
    poll(job.id);
  } catch (err) {
    submitBtn.disabled = false;
    showError("Could not reach the server.");
  }
});

$("again-btn").addEventListener("click", () => {
  hide($("video-box"));
  show($("placeholder"));
  $("video").removeAttribute("src");
  submitBtn.disabled = false;
});

async function loadHistory() {
  try {
    const res = await fetch("/api/jobs");
    const jobs = await res.json();
    const list = $("history-list");
    list.innerHTML = "";
    if (!jobs.length) {
      list.innerHTML = '<p style="color:var(--muted);font-size:13px">No videos yet.</p>';
      return;
    }
    jobs.forEach((job) => {
      const card = document.createElement("div");
      card.className = "history-card";
      card.innerHTML = `
        <h4>${(job.title || job.topic).slice(0, 60)}</h4>
        <p>${job.target_seconds}s target</p>
        <span class="badge ${job.status}">${job.status}</span>`;
      card.addEventListener("click", () => {
        if (job.status === "done") showVideo(job);
        else if (job.status === "running") { showProgress(); updateProgress(job); pollTimer = setInterval(() => poll(job.id), 1500); }
        else showError(job.error || "This job failed.");
      });
      list.appendChild(card);
    });
  } catch (e) { /* ignore */ }
}

loadHistory();
setInterval(loadHistory, 8000);
