import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourcePostUrl,
  normalizeXUsername,
  parseNominationCommand,
} from "./parser.js";

test("parses the explicit X nomination syntax", () => {
  assert.deepEqual(
    parseNominationCommand("Please help @NEARBuilders !onboard @Alice", "nearbuilders"),
    {
      nomineeUsername: "Alice",
      nomineeUsernameNormalized: "alice",
    },
  );
});

test("normalizes handles without changing displayed input", () => {
  assert.equal(normalizeXUsername(" @Alice "), "alice");
});

test("rejects implicit reply nominations and ambiguous commands", () => {
  assert.equal(parseNominationCommand("@NEARBuilders !onboard", "NEARBuilders"), null);
  assert.equal(
    parseNominationCommand("@NEARBuilders !onboard @alice and @NEARBuilders !onboard @bob", "NEARBuilders"),
    null,
  );
});

test("rejects mentions of a similarly named account", () => {
  assert.equal(
    parseNominationCommand("@NEARBuildersX !onboard @alice", "NEARBuilders"),
    null,
  );
});

test("builds the stable X post URL", () => {
  assert.equal(buildSourcePostUrl("123456789"), "https://x.com/i/web/status/123456789");
});
