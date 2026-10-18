import { useEffect, useRef } from "react";

const AUTO_CLOSE_MS = 5000;

export function Toast({ kind, message, onClose }: { kind: "error" | "success"; message: string; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => onCloseRef.current(), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [message]);
  if (!message) return null;
  return <div className={`toast ${kind}`}>{message}</div>;
}
