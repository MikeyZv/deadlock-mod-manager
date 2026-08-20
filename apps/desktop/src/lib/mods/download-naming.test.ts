import { describe, expect, it } from "bun:test";
import {
  fileNameFromUrl,
  isSameDownload,
  parseContentDisposition,
} from "@/lib/mods/download-naming";

describe("fileNameFromUrl", () => {
  it("recovers the creator's name from the redirected download url", () => {
    // Where a GameBanana 1-click link actually lands.
    expect(
      fileNameFromUrl("https://files.gamebanana.com/mods/gameinfo_70.rar"),
    ).toBe("gameinfo_70.rar");
  });

  it("treats an extensionless path segment as a route, not a name", () => {
    // Otherwise the 1-click link itself would be read as a file named "1513401".
    expect(fileNameFromUrl("https://gamebanana.com/mmdl/1513401")).toBeNull();
  });

  it("ignores query strings and fragments", () => {
    expect(
      fileNameFromUrl("https://cdn.example.com/mods/config.zip?token=abc#part"),
    ).toBe("config.zip");
  });

  it("decodes escapes in the name", () => {
    expect(
      fileNameFromUrl(
        "https://files.gamebanana.com/mods/Low%20Spec%20Config.zip",
      ),
    ).toBe("Low Spec Config.zip");
  });

  it("returns null for an empty url or one with no path", () => {
    expect(fileNameFromUrl("")).toBeNull();
    expect(fileNameFromUrl("https://gamebanana.com/")).toBeNull();
  });
});

describe("parseContentDisposition", () => {
  it("returns null when the server sends no header", () => {
    expect(parseContentDisposition(null)).toBeNull();
  });

  it("returns null when the header names no file", () => {
    expect(parseContentDisposition("attachment")).toBeNull();
  });

  it("reads a quoted file name", () => {
    expect(
      parseContentDisposition('attachment; filename="Low Spec Config.zip"'),
    ).toBe("Low Spec Config.zip");
  });

  it("reads an unquoted file name", () => {
    expect(parseContentDisposition("attachment; filename=config.7z")).toBe(
      "config.7z",
    );
  });

  it("decodes the RFC 5987 encoded form", () => {
    expect(
      parseContentDisposition(
        "attachment; filename*=UTF-8''Ultra%20Wide%20Config.zip",
      ),
    ).toBe("Ultra Wide Config.zip");
  });

  it("prefers the encoded form when both are present", () => {
    // Servers send the ASCII fallback for old clients; the encoded one is the
    // faithful name.
    expect(
      parseContentDisposition(
        "attachment; filename=\"Caf_ Config.zip\"; filename*=UTF-8''Caf%C3%A9%20Config.zip",
      ),
    ).toBe("Café Config.zip");
  });

  it("keeps a name containing a percent sign that is not an escape", () => {
    expect(
      parseContentDisposition('attachment; filename="100% Zoom.zip"'),
    ).toBe("100% Zoom.zip");
  });

  it("strips any directory portion from the served name", () => {
    // The name reaches the filesystem, so a served path must never survive.
    expect(
      parseContentDisposition('attachment; filename="../../evil/config.zip"'),
    ).toBe("config.zip");
    expect(
      parseContentDisposition(
        'attachment; filename="C:\\\\windows\\\\cfg.zip"',
      ),
    ).toBe("cfg.zip");
  });

  it("returns null when the name is only a path", () => {
    expect(
      parseContentDisposition('attachment; filename="folder/"'),
    ).toBeNull();
  });
});

describe("isSameDownload", () => {
  it("matches identical urls", () => {
    expect(
      isSameDownload(
        "https://gamebanana.com/mmdl/1234567",
        "https://gamebanana.com/mmdl/1234567",
      ),
    ).toBe(true);
  });

  it("matches the same download id across differing hosts", () => {
    // The published list and the 1-click link can be served from different
    // mirrors, so the id is what identifies the file.
    expect(
      isSameDownload(
        "https://files.gamebanana.com/mmdl/1234567",
        "https://gamebanana.com/mmdl/1234567?think=1",
      ),
    ).toBe(true);
  });

  it("does not match different download ids", () => {
    expect(
      isSameDownload(
        "https://gamebanana.com/mmdl/1234567",
        "https://gamebanana.com/mmdl/7654321",
      ),
    ).toBe(false);
  });

  it("does not match two urls that both lack a download id", () => {
    // Neither carries an id, so there is nothing to conclude from.
    expect(
      isSameDownload("https://example.com/a.zip", "https://example.com/b.zip"),
    ).toBe(false);
  });
});
