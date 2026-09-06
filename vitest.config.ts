import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/ui/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/ui/setup.ts"],
  },
});
