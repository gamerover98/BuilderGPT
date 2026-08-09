/**
 * Step 5 "hello world" — the cheapest possible proof that the sandbox engine
 * actually works in this runtime before trusting anything built on top of it
 * (RULEBOOK.md §3, core.ts's executeJsBuild). Per README.md's Step 5: "Hello
 * world. Then the smallest end-to-end command your binary supports. Cheap
 * proofs before expensive ones."
 *
 * Engine is quickjs-emscripten as of DEV-015 (isolated-vm cannot be loaded in
 * Electron). This file used to construct an `ivm.Isolate` directly; it now goes
 * through the same variant + module bootstrap `core.ts` uses, so a failure here
 * means the real code path is broken too, not just a test-only construction.
 */
import variantModule from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

const quickJs = await newQuickJSWASMModuleFromVariant(variantModule.default);
const runtime = quickJs.newRuntime();
const context = runtime.newContext();

try {
  const evaluation = context.evalCode("1 + 1");
  if (evaluation.error) {
    const detail = context.dump(evaluation.error);
    evaluation.error.dispose();
    throw new Error(`hello-world FAILED: ${JSON.stringify(detail)}`);
  }
  const result = context.dump(evaluation.value) as unknown;
  evaluation.value.dispose();
  if (result !== 2) {
    throw new Error(`hello-world FAILED: expected 2, got ${String(result)}`);
  }
  console.log("hello-world: quickjs-emscripten works. 1 + 1 =", result);
} finally {
  context.dispose();
  runtime.dispose();
}
