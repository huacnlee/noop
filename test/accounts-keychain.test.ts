// On macOS the default Claude login lives in the Keychain, so `.credentials.json` is missing and the credential stamp
// used to be 0: a stale needs_login ("OAuth session expired") never cleared after the owner logged in again.
import { expect, test } from "bun:test";
import { parseKeychainMdat } from "../src/accounts";

const sample = `keychain: "/Users/me/Library/Keychains/login.keychain-db"
attributes:
    "acct"<blob>="me"
    "mdat"<timedate>=0x32303236313132363032303931345A00  "20261126020914Z\\000"
    "svce"<blob>="Claude Code-credentials"`;

test("reads the keychain item's modification time", () => {
  expect(parseKeychainMdat(sample)).toBe(Date.UTC(2026, 10, 26, 2, 9, 14));
});

test("missing mdat → 0", () => {
  expect(parseKeychainMdat("security: The specified item could not be found in the keychain.")).toBe(0);
});
