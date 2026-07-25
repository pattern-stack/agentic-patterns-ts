/**
 * DataTable responsive core — column priority (`hideBelow`) + colSpan fixup +
 * scroll fallback. Desktop (jsdom default, no matchMedia stub) must render
 * unchanged so every existing DataTable consumer test keeps passing.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Column, DataTable } from "../components/organisms/DataTable";
import { __resetMediaQueryCacheForTests } from "../hooks/useMediaQuery";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetMediaQueryCacheForTests();
});

interface Row {
  id: string;
  name: string;
  region: string;
  notes: string;
}

const rows: Row[] = [{ id: "1", name: "Alpha", region: "US", notes: "n/a" }];

const columns: Column<Row>[] = [
  { key: "name", header: "Name" },
  { key: "region", header: "Region", hideBelow: "sm" },
  { key: "notes", header: "Notes", hideBelow: "md" },
];

/** Stubs `window.matchMedia` so `useBreakpoint` reports the band for `width`. */
function stubViewport(width: number) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const maxWidthMatch = query.match(/max-width:\s*(\d+)px/);
      const minWidthMatch = query.match(/min-width:\s*(\d+)px/);
      let matches = true;
      if (maxWidthMatch?.[1]) matches &&= width <= Number(maxWidthMatch[1]);
      if (minWidthMatch?.[1]) matches &&= width >= Number(minWidthMatch[1]);
      return {
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as MediaQueryList;
    }),
  );
}

describe("DataTable — responsive column priority", () => {
  it("desktop default renders all columns, including hideBelow ones", () => {
    render(<DataTable columns={columns} data={rows} />);
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.getByText("Region")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
    const nameHeader = screen.getByText("Name");
    expect(nameHeader.style.padding).toBe("10px 14px");
  });

  it("phone viewport drops sm and md columns, keeps untagged ones", () => {
    stubViewport(500);
    render(<DataTable columns={columns} data={rows} />);
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.queryByText("Region")).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
  });

  it("narrow (tablet) viewport drops only md columns", () => {
    stubViewport(700);
    render(<DataTable columns={columns} data={rows} />);
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.getByText("Region")).toBeTruthy();
    expect(screen.queryByText("Notes")).toBeNull();
  });

  it("colSpan of the empty-state row matches the filtered visible-column count", () => {
    stubViewport(500);
    render(<DataTable columns={columns} data={[]} />);
    const cell = screen.getByText("No data");
    // 3 columns, 2 hidden at phone width -> 1 visible column, no expand col.
    expect(cell.getAttribute("colspan")).toBe("1");
  });

  it("colSpan of the expanded-detail row matches visible + 1 (expand column)", () => {
    stubViewport(500);
    render(
      <DataTable
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        expandedKey="1"
        onToggleExpand={() => {}}
        renderExpanded={() => <div>Details</div>}
      />,
    );
    const detail = screen.getByText("Details");
    const cell = detail.closest("td");
    expect(cell).not.toBeNull();
    // 1 visible column ("Name") + 1 expand column = 2.
    expect(cell?.getAttribute("colspan")).toBe("2");
  });

  it("wrapper degrades to horizontal scroll rather than clipping", () => {
    const { container } = render(<DataTable columns={columns} data={rows} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.overflowX).toBe("auto");
  });
});
