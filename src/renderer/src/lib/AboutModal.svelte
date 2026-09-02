<script lang="ts">
  /**
   * What this application is, said once, where somebody can find it.
   *
   * Nothing in the running app named its version, its licence, what it is
   * derived from, or that it costs nothing -- all of which lived only in
   * `README.md`, which is to say only on GitHub, which is to say nowhere for
   * anyone who installed it. Help -> About is the first place a person looks
   * for exactly these facts, and it was the one menu the app did not have.
   *
   * Same skeleton as every other modal here, `VersionsModal`'s in particular,
   * including the pointer-lock release: this opens over the viewport, and in
   * flight the canvas holds the pointer, so a panel over a camera still turning
   * underneath is the documented failure.
   *
   * The version comes from main (`AppInfo`), not from a constant compiled in
   * beside it. `info` is therefore `null` for one await after the box opens,
   * which is a real state and is drawn as one rather than as a zero.
   */
  import type { AppInfo } from "../../../shared/ipc.js";
  import { t } from "./i18n.svelte.js";
  /*
   * The only asset import in the renderer. Vite emits it under
   * `out/renderer/assets/` and references it by relative URL, which the CSP's
   * `img-src 'self' data:` covers -- as it would the inlined `data:` form vite
   * uses for small files, so neither outcome needs a policy change.
   *
   * It is generated into the renderer's own tree by `scripts/gen-icons.mjs`
   * rather than imported across the vite root from `build/`, which would work
   * only for as long as `server.fs.allow`'s search kept reaching the repo root.
   */
  import logo from "../assets/logo.png";

  interface Props {
    open: boolean;
    /** `null` until main has answered; one await, on first open. */
    info: AppInfo | null;
    onclose: () => void;
  }

  const { open, info, onclose }: Props = $props();

  let dialog = $state<HTMLDivElement | null>(null);

  const REPOSITORY = "https://github.com/gamerover98/Schematic-Ai-Studio";
  const UPSTREAM = "https://github.com/CyniaAI/BuilderGPT";
  const FAITHFUL = "https://faithfulpack.net/";
  const LICENSE = "https://www.apache.org/licenses/LICENSE-2.0";

  /**
   * The runtime line, which is the row a bug report wants.
   *
   * One string rather than three fields: it is read once, copied once, and
   * pasted into an issue, and three labelled rows would be three things to
   * select instead of one.
   */
  const runtime = $derived(
    info === null
      ? null
      : `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}`,
  );

  $effect(() => {
    if (open) {
      document.exitPointerLock();
      dialog?.focus();
    }
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }
</script>

{#if open}
  <div
    class="scrim"
    role="presentation"
    onkeydown={onKeydown}
    onclick={(event) => {
      if (event.target === event.currentTarget) onclose();
    }}
  >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("about.title")}
      tabindex="-1"
      bind:this={dialog}
    >
      <header>
        <h2>{t("about.title")}</h2>
        <button class="icon close" onclick={onclose} aria-label={t("common.close")}
          >&#x00d7;</button
        >
      </header>

      <div class="body">
        <!--
          `alt=""` on purpose: the app name is the very next element, so a
          screen reader given alt text here would announce the name twice. It
          also keeps this out of the catalogue, where `tests/ui.ts` objects to
          both a key with no message and a message nobody asks for.
        -->
        <img class="logo" src={logo} alt="" width="72" height="72" />
        <p class="name">{t("app.title")}</p>
        <p class="version">
          {t("about.version", { version: info?.version ?? "—" })}
        </p>

        <p class="tagline">{t("about.tagline")}</p>

        <!--
          The point of the box rather than a footnote at the bottom of it.
          There are paid services promising the same thing; this one is not
          one of them, and somebody who has just installed it has no other way
          of knowing that.
        -->
        <p class="free">{t("about.free")}</p>

        <section>
          <h3>{t("about.runtime")}</h3>
          <p class="runtime">{runtime ?? "—"}</p>
        </section>

        <section>
          <h3>{t("about.credits")}</h3>
          <ul>
            <li>
              <a href={UPSTREAM} target="_blank" rel="noreferrer">CyniaAI/BuilderGPT</a>
              {" — "}{t("about.credit.origin")}
            </li>
            <li>
              <a href={FAITHFUL} target="_blank" rel="noreferrer">Faithful</a>
              {" — "}{t("about.credit.faithful")}
            </li>
            <li>{t("about.credit.libraries")}</li>
          </ul>
          <p class="hint">{t("about.credit.more")}</p>
        </section>
      </div>

      <footer>
        <!--
          External links are safe here and go to the system browser:
          `main/index.ts` answers `setWindowOpenHandler` with
          `shell.openExternal` and refuses `will-navigate` outright, so a
          `target="_blank"` cannot navigate the window away from the app.
        -->
        <a class="link" href={REPOSITORY} target="_blank" rel="noreferrer">
          {t("about.repository")}
        </a>
        <a class="link" href={LICENSE} target="_blank" rel="noreferrer">
          {t("about.license")}
        </a>
        <span class="spacer"></span>
        <button onclick={onclose}>{t("common.close")}</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scrim);
    backdrop-filter: blur(2px);
  }

  .modal {
    position: relative;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    width: min(460px, calc(100vw - 48px));
    max-height: min(600px, calc(100vh - 64px));
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-panel);
    box-shadow: 0 16px 48px var(--shadow);
    outline: none;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    padding: 14px 18px 8px;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .close {
    position: absolute;
    top: 10px;
    right: 12px;
  }

  /* `min-height: 0` so the body scrolls inside the modal rather than growing
     it past the viewport -- the same grid-child rule the other modals need. */
  .body {
    min-height: 0;
    padding: 4px 18px 12px;
    overflow-y: auto;
  }

  /* Sized in CSS as well as in the attributes: the attributes reserve the
     square before the file loads, these keep it right if the generated asset
     is ever regenerated at another size. */
  .logo {
    display: block;
    width: 72px;
    height: 72px;
    margin: 4px 0 10px;
  }

  .name {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }

  .version {
    margin: 2px 0 12px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .tagline {
    margin: 0 0 10px;
    font-size: 12px;
    line-height: 1.6;
  }

  .free {
    margin: 0 0 16px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.6;
  }

  section {
    margin-bottom: 14px;
  }

  h3 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }

  .runtime {
    margin: 0;
    font-size: 11px;
    line-height: 1.6;
    color: var(--text-dim);
    /* Selectable and wrapping: this row exists to be copied into a report. */
    user-select: text;
    overflow-wrap: anywhere;
  }

  ul {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.7;
  }

  .hint {
    margin: 6px 0 0;
    font-size: 11px;
    line-height: 1.6;
    color: var(--text-dim);
  }

  footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px 14px;
    border-top: 1px solid var(--border);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .link {
    font-size: 12px;
  }
</style>
