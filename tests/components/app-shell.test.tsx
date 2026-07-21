import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app";

describe("App", () => {
  it("introduces the private local library", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "你的書庫" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "匯入 EPUB" })).toBeTruthy();
    expect(screen.getByText("書籍只會儲存在此裝置")).toBeTruthy();
  });
});
