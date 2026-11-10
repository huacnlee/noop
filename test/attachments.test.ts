import { expect, test } from "bun:test";
import { attachmentName, isDoc, isImage } from "../app/files";

test("documents and patches are not images; image formats and extensionless uploads remain images", () => {
  for (const file of ["report.md", "settings.json", "fix.patch", "changes.diff", "log.txt", "bundle.zip", "manual.pdf"])
    expect(isImage(`/media/1794210870393-${file}?token=x`)).toBe(false);
  for (const file of ["shot.png", "photo.JPG", "anim.gif", "pic.webp", "pic.avif", "pic.heic", "image", "pic.svg"])
    expect(isImage(`/media/1794210870393-${file}?token=x`)).toBe(true);
  expect(isImage("blob:https://hub.example/preview-id")).toBe(true);
  expect(isImage("data:image/png;base64,AAAA")).toBe(true);
});

test("markdown attachments are documents, images are not", () => {
  expect(isDoc("/media/1731-report.md")).toBe(true);
  expect(isDoc("/media/1731-notes.markdown?token=x")).toBe(true);
  expect(isDoc("/media/1731-shot.png")).toBe(false);
});

test("attachment names drop the storage timestamps", () => {
  expect(attachmentName("/media/1762650000000-1762650000123-push-notifications.md")).toBe("push-notifications.md");
  expect(attachmentName("https://hub.example/media/1762650000000-report.md?token=x")).toBe("report.md");
  expect(attachmentName("/media/plain.md")).toBe("plain.md");
});
