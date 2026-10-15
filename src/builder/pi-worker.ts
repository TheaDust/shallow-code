import { createPiSession, type PiSessionSnapshot } from "./pi-sdk-adapter.js";
import { subtractUsage, type ExecutionUsage } from "./pi-execution-stats.js";
import { installSseCapture } from "./sse-capture.js";
import { installSseResilience } from "./sse-resilience.js";
import { closeSharedBrowser } from "./pi-browser-tool.js";
import { loadReferenceImages } from "./reference-images.js";
import { isImageUnsupportedMessage } from "./vision-probe.js";
import type { PiWorkerRequest, PiWorkerResult, PiWorkerProgress } from "./pi-worker-client.js";
import { fillTemplate, loadPrompt } from "../prompt-assets.js";
import { classifyGatewayFailure, observeGatewayFailures } from "../gateway-failure.js";

// Wait for ownership to be established by the parent before executing anything.
process.once("message", (request: PiWorkerRequest) => {
  void run(request).then(send, error => send({ sessionId: "unavailable", outcome: "failed", summary: error instanceof Error ? error.message : String(error) }));
});
process.on("disconnect", () => process.exit(1));

function send(result: PiWorkerResult): void {
  // Parent receives a bounded receipt, then kills the owned job/group and awaits cleanup.
  process.send?.(result);
}

async function run(input: PiWorkerRequest): Promise<PiWorkerResult> {
  let baseline: ExecutionUsage | undefined;
  // 续做会话的统计包含此前调用；先记录基线，上报与回执都只给本次调用增量。
  const rebase = (snapshot: PiSessionSnapshot): PiSessionSnapshot => baseline === undefined ? snapshot
    : { ...snapshot, usage: subtractUsage(snapshot.usage, baseline) };
  const session = await createPiSession(input, snapshot => {
    process.send?.({ type: "builder_progress", ...rebase(snapshot) } satisfies PiWorkerProgress);
  });
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
  // Install capture first so it tees the raw body, then resilience outermost so
  // the client reads a repaired stream while diagnostics keep the original bytes.
  const capture = input.sseCaptureDir ? installSseCapture(input.sseCaptureDir, input.sessionKey ?? "builder") : undefined;
  const resilience = installSseResilience(raw => process.stderr.write(`[ShallowCode] 检测到损坏的网关 SSE 事件：${raw}\n`));
  const gateway = observeGatewayFailures(input.gateway.baseUrl);
  try {
    const imageNote = !input.references?.length ? "" : !attach || input.visionUnsupported
      ? loadPrompt("system", "reference-images-text-fallback")
      : input.textOnly ? loadPrompt("system", "reference-images-text-fallback")
      : fillTemplate(loadPrompt("system", "reference-images"), {
        ATTACHED_REFERENCES: loaded.images.map(image => `- ${image.reference}`).join("\n") || "无",
        UNAVAILABLE_REFERENCES: loaded.skipped.map(item => `- ${item.reference}: ${item.reason}`).join("\n") || "无",
      });
    let result = await session.prompt(`${input.taskPrompt}\n\n${imageNote}`, images);
    if (result.terminationReason === "empty_terminal_response") {
      result = await session.prompt(loadPrompt("system", "completion-receipt"));
    }
    const { outcome, summary, providerError, terminationReason } = result;
    const stats = rebase(session.snapshot());
    const success = outcome === "completed";
    const observedFailure = gateway.failure();
    return { ...stats, outcome, summary: summary.slice(-8_000),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      ...(terminationReason ? { terminationReason } : {}),
      ...(!success && observedFailure ? { gatewayFailure: classifyGatewayFailure(observedFailure, providerError) } : {}),
      imageUnsupported: !success && images.length > 0 && stats.toolCalls === 0 && isImageUnsupportedMessage(summary),
      ...(input.references?.length ? { referenceImages: {
        mode: !attach ? "disabled" : input.visionUnsupported ? "unsupported" : input.textOnly ? "text_fallback" : images.length ? "attached" : "unavailable",
        attachedCount: images.length, skipped: loaded.skipped } as const } : {}),
    };
  } finally { clearInterval(progressTimer); session.dispose(); gateway.uninstall(); resilience.uninstall(); await capture?.uninstall(); await closeSharedBrowser(); }
}
