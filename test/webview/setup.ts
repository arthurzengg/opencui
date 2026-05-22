import "@testing-library/jest-dom/vitest"
import { vi } from "vitest"

// Webview tests run in jsdom — provide minimal globals that the modules expect.
// `acquireVsCodeApi` is injected by VS Code's webview runtime; tests stub it
// so any module that imports `./vscode` (the webview's vscode bridge) works.
;(window as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
})

// jsdom doesn't ship a ResizeObserver implementation. `useHeaderPopoverHeight`
// (and any future hook that observes layout) constructs one on mount; tests
// only need the constructor and disconnect/observe to exist as no-ops, since
// they don't exercise the resize-driven side effect.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub
