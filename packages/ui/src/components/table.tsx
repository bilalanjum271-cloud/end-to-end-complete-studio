import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: 'start' | 'end';
  /** Use the mono face (timings, amounts, ids). */
  mono?: boolean;
}

export function Table<T>({ columns, rows, rowKey, caption }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-base">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-surface-1">
            {columns.map((c) => (
              <th key={c.key} scope="col"
                className={cn('h-10 px-4 text-xs font-medium tracking-wide text-fg-subtle uppercase', c.align === 'end' ? 'text-end' : 'text-start')}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-t border-line transition-colors duration-150 hover:bg-surface-1">
              {columns.map((c) => (
                <td key={c.key} className={cn('h-12 px-4 text-fg', c.align === 'end' ? 'text-end' : 'text-start', c.mono && 'font-mono text-sm tabular-nums')}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
