import { useEffect, useRef } from "preact/hooks";

export interface DeleteDialogProps {
  bookTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteDialog({
  bookTitle,
  onConfirm,
  onCancel,
}: DeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      class="delete-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        class="delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
      >
        <h2 id="delete-dialog-title" class="delete-dialog-title">
          刪除此書？
        </h2>
        <p class="delete-dialog-body">
          確定要刪除「{bookTitle}」？此操作無法復原。
        </p>
        <div class="delete-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            class="touch-target dialog-cancel"
            style={{ minWidth: "44px", minHeight: "44px" }}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            class="touch-target dialog-confirm"
            style={{ minWidth: "44px", minHeight: "44px" }}
            onClick={onConfirm}
          >
            刪除
          </button>
        </div>
      </div>
    </div>
  );
}
