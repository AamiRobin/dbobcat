import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { bytesToDataUrl, detectImage, hexDump, tryDecodeUtf8 } from "@/lib/blob-view";
import { formatByteSize } from "@/lib/grid-columns";
import type { RowValue } from "@/types/ipc";

/**
 * Right-side-style dialog for inspecting binary cell payloads:
 * image preview when magic bytes match, else UTF-8 text when decodable,
 * else a classic hex dump. (File download lands with the Phase 5 export
 * plumbing.)
 */
export function BlobViewerDialog({
  value,
  onClose,
}: {
  /** The bytes payload being viewed; null closes/resets. */
  value: Extract<RowValue, { t: "bytes" }> | null;
  onClose: () => void;
}) {
  const analysis = useMemo(() => {
    if (!value) return null;
    const bytes = value.v;
    const image = detectImage(bytes);
    if (image) return { kind: "image" as const, mime: image.mime };
    const text = tryDecodeUtf8(bytes);
    if (text !== null) return { kind: "text" as const, text };
    return { kind: "hex" as const, dump: hexDump(bytes) };
  }, [value]);

  return (
    <Dialog open={value !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] w-[min(760px,90vw)] flex-col sm:max-w-[760px]">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            Binary Viewer
            {value && (
              <Badge variant="secondary" className="font-mono">
                {formatByteSize(value.v.length)}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {analysis?.kind === "image"
              ? "Image preview"
              : analysis?.kind === "text"
                ? "UTF-8 text content"
                : "Binary content — hex view"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background p-2">
          {!analysis ? null : analysis.kind === "image" ? (
            <img
              src={bytesToDataUrl(value!.v, analysis.mime)}
              alt="BLOB preview"
              className="mx-auto max-h-[52vh] max-w-full object-contain"
            />
          ) : analysis.kind === "text" ? (
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
              {analysis.text}
            </pre>
          ) : (
            <pre className="font-mono text-[11px] leading-relaxed">{analysis.dump}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
