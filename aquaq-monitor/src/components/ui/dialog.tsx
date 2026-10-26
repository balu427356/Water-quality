import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Modal dialog on the native <dialog> element: focus trap, Esc to close and backdrop come from the browser. */
export function Dialog({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dlg-title"
      className={cn('w-[min(32rem,calc(100vw-2rem))] rounded-lg border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-black/50', className)}
    >
      {open && (
        <div className="p-4">
          <div className="mb-3 flex items-start justify-between gap-2">
            <h2 id="dlg-title" className="text-lg font-semibold">
              {title}
            </h2>
            <button onClick={onClose} className="rounded p-1 hover:bg-muted" aria-label="Close dialog">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
