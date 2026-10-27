import { useState } from "react";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
}

type Handler = (options: ConfirmOptions) => Promise<boolean>;

let handler: Handler | null = null;

/** 统一的二次确认弹窗(替代 window.confirm)。挂载 ConfirmProvider 后生效。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (!handler) return Promise.resolve(window.confirm(options.title));
  return handler(options);
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

/** 在应用根部挂载一次；confirmDialog 的渲染载体。 */
export function ConfirmProvider() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  handler = (options) =>
    new Promise<boolean>((resolve) => {
      setPending({ options, resolve });
    });

  if (!pending) return null;
  const finish = (value: boolean) => {
    pending.resolve(value);
    setPending(null);
  };
  const { options } = pending;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => finish(false)}>
      <section className="dataset-dialog dataset-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ywa-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow">CONFIRM</span>
            <h2 id="ywa-confirm-title">{options.title}</h2>
            {options.description ? <p>{options.description}</p> : null}
          </div>
          <button className="icon-button" onClick={() => finish(false)} aria-label="关闭">×</button>
        </header>
        <footer>
          <button className="button" onClick={() => finish(false)}>取消</button>
          <button className={options.danger === false ? "button primary" : "button danger"} autoFocus onClick={() => finish(true)}>{options.confirmLabel ?? "确认"}</button>
        </footer>
      </section>
    </div>
  );
}
