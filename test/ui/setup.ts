import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });

afterEach(() => cleanup());
