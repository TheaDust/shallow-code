import { createPiSession, type PiSessionSnapshot } from "./pi-sdk-adapter.js";
import { subtractUsage, type ExecutionUsage } from "./pi-execution-stats.js";
import { installSseCapture } from "./sse-capture.js";
import type { BuilderCapabilityPack } from "../application/port.js";
import { loadReferenceImages } from "./reference-images.js";
import { isImageUnsupportedMessage } from "./vision-probe.js";
import type { PiWorkerRequest, PiWorkerResult, PiWorkerProgress } from "./pi-worker-client.js";
import { fillTemplate, loadPrompt } from "../prompt-assets.js";

export async function runPiWorker(input: PiWorkerRequest, capabilities?: BuilderCapabilityPack): Promise<PiWorkerResult> {
  let baseline: ExecutionUsage | undefined;
  // 续做会话的统计包含此前调用；先记录基线，上报与回执都只给本次调用增量。
  const rebase = (snapshot: PiSessionSnapshot): PiSessionSnapshot => baseline === undefined ? snapshot
    : { ...snapshot, usage: subtractUsage(snapshot.usage, baseline) };
  const session = await createPiSession(input, snapshot => {
    process.send?.({ type: "builder_progress", ...rebase(snapshot) } satisfies PiWorkerProgress);
  }, capabilities);
  baseline = session.snapshot().usage;
  const reportProgress = () => {
    process.send?.({ type: "builder_progress", ...rebase(session.snapshot()) } satisfies PiWorkerProgress);
  };
  const progressTimer = setInterval(reportProgress, 15_000);
  progressTimer.unref();
  // attachReferences=false is the run's switch: references stay declared for the
  // log, but no image is read off disk and none reaches the model.
  const attach = input.attachReferences !== false;
  const loaded = !attach
    ? { images: [], skipped: [] }
    : !input.textOnly && input.requirementsDir && input.references?.length
      ? await loadReferenceImages(input.requirementsDir, input.references) : { images: [], skipped: input.textOnly ? [] : (input.references ?? []).map(reference => ({ reference, reason: "requirements_unavailable" })) };
  const images = attach && !input.textOnly ? loaded.images.map(image => ({ type: "image" as const, mimeType: image.mime, data: image.dataUrl.slice(image.dataUrl.indexOf(",") + 1) })) : [];
  // The adapter installs shared gateway repair after capture, preserving raw diagnostics.
  const capture = input.sseCaptureDir ? installSseCapture(input.sseCaptureDir, input.sessionKey ?? "builder") : undefined;
  try {
    const imageNote = !input.references?.length ? "" : !attach || input.visionUnsupported
      ? loadPrompt("builder", "reference-images-text-fallback")
      : input.textOnly ? loadPrompt("builder", "reference-images-text-fallback")
      : fillTemplate(loadPrompt("builder", "reference-images"), {
        ATTACHED_REFERENCES: loaded.images.map(image => `- ${image.reference}`).join("\n") || "无",
        UNAVAILABLE_REFERENCES: loaded.skipped.map(item => `- ${item.reference}: ${item.reason}`).join("\n") || "无",
      });
    let result = await session.prompt(`${input.taskPrompt}\n\n${imageNote}`, images);
    if (result.terminationReason === "empty_terminal_response") {
      result = await session.prompt(loadPrompt("builder", "completion-receipt"));
    }
    const { outcome, summary, gatewayFailure, terminationReason } = result;
    const stats = rebase(session.snapshot());
    const success = outcome === "completed";
    return { ...stats, outcome, summary: summary.slice(-8_000),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      ...(terminationReason ? { terminationReason } : {}),
      ...(!success && gatewayFailure ? { gatewayFailure } : {}),
      imageUnsupported: !success && images.length > 0 && stats.toolCalls === 0 && isImageUnsupportedMessage(summary),
      ...(input.references?.length ? { referenceImages: {
        mode: !attach ? "disabled" : input.visionUnsupported ? "unsupported" : input.textOnly ? "text_fallback" : images.length ? "attached" : "unavailable",
        attachedCount: images.length, skipped: loaded.skipped } as const } : {}),
    };
  } finally { clearInterval(progressTimer); session.dispose(); await capture?.uninstall(); }
}
