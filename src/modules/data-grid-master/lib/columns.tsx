import type {
  ColDef,
  ColGroupDef,
  ICellRendererParams,
  ValueGetterParams,
} from "ag-grid-community";
import type { GridRow, Status } from "./types";
import { DEPARTMENTS, STATUSES } from "./types";

/**
 * Column definitions for the synthetic schema. Every entry deliberately
 * exercises a distinct AG Grid Community capability so the showcase covers the
 * key-features page: column groups, pinning, value getters/formatters, all
 * provided cell editors, custom cell renderers, conditional styling, tooltips,
 * and the per-type column filters + floating filters.
 *
 * Renderers are plain functions returning DOM/HTML strings (AG Grid renders the
 * return value); keeping them framework-free avoids per-cell React reconciliation
 * on a virtualized grid with 200k rows.
 */

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const STATUS_COLOR: Record<Status, string> = {
  active: "#16a34a",
  onboarding: "#0ea5e9",
  leave: "#d97706",
  alumni: "#71717a",
};

/** Status badge: a pill coloured by status. Returned as an HTML string. */
function statusBadge(p: ICellRendererParams<GridRow, Status>): string {
  const v = p.value;
  if (!v) return "";
  const color = STATUS_COLOR[v];
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1;padding:2px 7px;border-radius:9999px;background:${color}22;color:${color};border:1px solid ${color}55;text-transform:capitalize">${v}</span>`;
}

/** Performance: a 0..100 progress bar with the number overlaid. */
function progressBar(p: ICellRendererParams<GridRow, number>): string {
  const v = Math.max(0, Math.min(100, p.value ?? 0));
  const hue = Math.round((v / 100) * 120); // red -> green
  return `<div style="position:relative;height:14px;border-radius:3px;background:var(--accent);overflow:hidden"><div style="position:absolute;inset:0;width:${v}%;background:hsl(${hue} 70% 45%)"></div><span style="position:relative;font-size:10px;line-height:14px;padding-left:5px;color:var(--foreground)">${v}</span></div>`;
}

/** Inline SVG sparkline for the 12-point trend series (Community-friendly,
 *  no Enterprise Sparklines module). */
function sparkline(p: ICellRendererParams<GridRow, number[]>): string {
  const data = p.value;
  if (!data || data.length === 0) return "";
  const w = 80;
  const h = 18;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data
    .map((d, i) => {
      const x = (i * step).toFixed(1);
      const y = (h - ((d - min) / span) * h).toFixed(1);
      return `${x},${y}`;
    })
    .join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block"><polyline points="${pts}" fill="none" stroke="var(--ring)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export function buildColumnDefs(): (ColDef<GridRow> | ColGroupDef<GridRow>)[] {
  return [
    {
      headerName: "#",
      colId: "rowIndex",
      // Value getter: derive the 1-based display index from the node, not data.
      valueGetter: (p: ValueGetterParams<GridRow>) =>
        p.node ? (p.node.rowIndex ?? 0) + 1 : "",
      width: 70,
      pinned: "left",
      sortable: false,
      filter: false,
      suppressMovable: true,
      // Managed row drag handle lives on the pinned index column.
      rowDrag: true,
    },
    {
      headerName: "Identity",
      // Column group: nests the name/email children under one header.
      children: [
        {
          field: "firstName",
          headerName: "First",
          pinned: "left",
          editable: true,
          filter: "agTextColumnFilter",
          floatingFilter: true,
          minWidth: 110,
        },
        {
          field: "lastName",
          headerName: "Last",
          pinned: "left",
          editable: true,
          filter: "agTextColumnFilter",
          floatingFilter: true,
          minWidth: 110,
        },
        {
          colId: "email",
          headerName: "Email",
          // Value getter: composed, never stored on the row.
          valueGetter: (p: ValueGetterParams<GridRow>) =>
            p.data ? p.data.email : "",
          tooltipValueGetter: (p) => String(p.value ?? ""),
          minWidth: 200,
          columnGroupShow: "open",
        },
      ],
    },
    {
      field: "department",
      headerName: "Department",
      editable: true,
      // Provided select editor with a fixed option list.
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: [...DEPARTMENTS] },
      filter: "agTextColumnFilter",
      floatingFilter: true,
      enableRowGroup: false,
      minWidth: 140,
    },
    {
      field: "status",
      headerName: "Status",
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: [...STATUSES] },
      cellRenderer: statusBadge,
      filter: "agTextColumnFilter",
      floatingFilter: true,
      minWidth: 130,
    },
    {
      field: "salary",
      headerName: "Salary",
      type: "numericColumn",
      editable: true,
      // Number editor + parser so typed text becomes a number again.
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 0, precision: 0 },
      valueFormatter: (p) =>
        p.value == null ? "" : currency.format(Number(p.value)),
      // Conditional styling: flag high earners.
      cellClassRules: {
        "font-semibold": (p) => Number(p.value) >= 200_000,
      },
      filter: "agNumberColumnFilter",
      floatingFilter: true,
      minWidth: 120,
    },
    {
      field: "performance",
      headerName: "Performance",
      cellRenderer: progressBar,
      type: "numericColumn",
      filter: "agNumberColumnFilter",
      floatingFilter: true,
      minWidth: 130,
    },
    {
      field: "trend",
      headerName: "Trend",
      cellRenderer: sparkline,
      sortable: false,
      filter: false,
      minWidth: 100,
    },
    {
      field: "hireDate",
      headerName: "Hire date",
      editable: true,
      // Date editor; values are ISO strings the date filter understands.
      cellEditor: "agDateStringCellEditor",
      filter: "agDateColumnFilter",
      floatingFilter: true,
      minWidth: 130,
    },
    {
      field: "active",
      headerName: "Active",
      editable: true,
      // Checkbox editor + boolean cell data type.
      cellDataType: "boolean",
      cellEditor: "agCheckboxCellEditor",
      cellRenderer: "agCheckboxCellRenderer",
      filter: false,
      width: 90,
    },
    {
      field: "notes",
      headerName: "Notes",
      editable: true,
      // Large-text popup editor.
      cellEditor: "agLargeTextCellEditor",
      cellEditorPopup: true,
      cellEditorParams: { maxLength: 200, rows: 4, cols: 40 },
      tooltipValueGetter: (p) => String(p.value ?? ""),
      filter: "agTextColumnFilter",
      minWidth: 220,
      flex: 1,
    },
  ];
}

/** Column defs for the dynamic (real-file) source: index-keyed string columns. */
export function buildFileColumnDefs(columns: string[]): ColDef[] {
  return columns.map((name, i) => ({
    headerName: name,
    field: `c${i}`,
    colId: `c${i}`,
    valueFormatter: (p) => (p.value === null ? "NULL" : p.value),
    cellClass: (p) =>
      p.value === null ? "italic text-muted-foreground/60" : "",
    filter: "agTextColumnFilter",
    floatingFilter: true,
    resizable: true,
    minWidth: 100,
    flex: 1,
  }));
}
