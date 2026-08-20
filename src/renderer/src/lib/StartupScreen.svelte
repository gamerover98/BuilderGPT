<script lang="ts">
  /**
   * What the app is doing before it can be used.
   *
   * There was no such phase, and that was survivable until the block warm-up
   * arrived: meshing nine hundred blocks so the texture atlas stops moving is
   * seconds of the main process, and it used to start the first time anything
   * asked for an icon — which is the moment a schematic opens. The window sat
   * there, apparently hung, because every IPC call was queued behind it.
   *
   * So it happens here instead, up front, where waiting is what the screen is
   * for. Naming the steps is the rest of it: "loading" says nothing, and the
   * one step that takes real time deserves to say why.
   */
  import { t } from "./i18n.svelte.js";

  export interface StartupStep {
    id: string;
    /** Already translated: the caller owns the wording. */
    label: string;
    state: "pending" | "running" | "done";
    /** Only the warm-up has one, and only while it runs. */
    progress?: { done: number; total: number };
  }

  interface Props {
    steps: readonly StartupStep[];
  }

  const { steps }: Props = $props();
</script>

<div class="startup" role="status" aria-live="polite">
  <div class="card">
    <h1>{t("app.title")}</h1>
    <p class="lead">{t("startup.lead")}</p>

    <ul>
      {#each steps as step (step.id)}
        <li class={step.state}>
          <span class="mark" aria-hidden="true">
            {#if step.state === "done"}&#x2713;{:else if step.state === "running"}&#x25CF;{:else}&#x25CB;{/if}
          </span>
          <span class="label">{step.label}</span>
          {#if step.state === "running" && step.progress}
            <span class="count">
              {step.progress.done.toLocaleString()} / {step.progress.total.toLocaleString()}
            </span>
          {/if}
        </li>
        {#if step.state === "running" && step.progress}
          <!-- A bar only for the step that has a length worth showing. The
               others finish before the eye reaches them. -->
          <li class="bar-row">
            <div
              class="bar"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax={step.progress.total}
              aria-valuenow={step.progress.done}
            >
              <div
                class="fill"
                style={`width: ${Math.round((step.progress.done / Math.max(1, step.progress.total)) * 100)}%`}
              ></div>
            </div>
          </li>
        {/if}
      {/each}
    </ul>
  </div>
</div>

<style>
  .startup {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
  }

  .card {
    width: min(380px, 100%);
    padding: 24px 26px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-panel);
    box-shadow: 0 16px 48px var(--shadow);
  }

  h1 {
    margin: 0 0 4px;
    font-size: 17px;
    font-weight: 600;
  }

  .lead {
    margin: 0 0 18px;
    font-size: 12px;
    color: var(--text-dim);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0;
    font-size: 12px;
    color: var(--text-dim);
  }

  li.running {
    color: var(--text);
  }

  .mark {
    flex: none;
    width: 12px;
    text-align: center;
    font-size: 10px;
  }

  li.done .mark {
    color: var(--accent);
  }

  .label {
    flex: 1 1 auto;
    min-width: 0;
  }

  .count {
    flex: none;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
  }

  .bar-row {
    padding: 2px 0 6px 20px;
  }

  .bar {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: var(--bg-input);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--accent);
    /* Eased, because the warm-up reports in bursts of sixteen and an unsmoothed
       bar reads as stuttering rather than as progress. */
    transition: width 120ms linear;
  }
</style>
