"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const functionSource = require("./test-function-source");
const template = fs.readFileSync(require.resolve("../src/INASearch.template.html"), "utf8");

function shareRuntime(href, preferences) {
  const defaults = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/INASearch-Profile.js"), "utf8"), defaults);
  const attributes = {};
  const context = vm.createContext({
    URL, String, Boolean,
    window: { location: { href } },
    profile: { preferences: preferences ?? defaults.window.INA_SEARCH_PROFILE.preferences },
    currentShareQuery: () => 'INA 212(a)(9)(B)(i)(I), CFR "student status"',
    LOCAL_SHARE_LINK_WARNING: "Local link warning",
    els: { mainShareLocalWarning: { hidden: false }, mainShareButton: { setAttribute: (name, value) => { attributes[name] = value; } } }
  });
  for (const name of ["currentViewShareLink", "legalUnitShareLink", "syncMainShareWarning"]) vm.runInContext(functionSource(template, name), context);
  return { app: context, attributes };
}

test("downloaded copies share the hosted destination and hide the local warning by default", () => {
  const { app, attributes } = shareRuntime("file:///downloads/INASearch.html?private=1#old");
  const link = app.currentViewShareLink();
  const url = new URL(link.href);
  assert.equal(url.origin, "https://inasearch.pages.dev");
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("q"), 'INA 212(a)(9)(B)(i)(I), CFR "student status"');
  assert.equal(url.searchParams.get("qv"), "2");
  assert.deepEqual([...url.searchParams.keys()], ["q", "qv"]);
  assert.equal(url.hash, "");
  assert.equal(link.local, false);
  app.syncMainShareWarning();
  assert.equal(app.els.mainShareLocalWarning.hidden, true);
  assert.equal(attributes["aria-label"], "Copy link to current view");
});

test("existing profiles without the new preference also use hosted sharing", () => {
  const { app } = shareRuntime("file:///downloads/INASearch.html", {});
  assert.equal(new URL(app.legalUnitShareLink("8 CFR 214.2(h)(1)").href).origin, "https://inasearch.pages.dev");
});

test("turning hosted sharing off preserves local citation links and their warning", () => {
  const { app, attributes } = shareRuntime("file:///downloads/INASearch.html", { useHostedShareLinks: false });
  const link = app.legalUnitShareLink("8 CFR 214.2(h)(1)");
  assert.equal(new URL(link.href).protocol, "file:");
  assert.equal(new URL(link.href).searchParams.get("q"), "8 CFR 214.2(h)(1)");
  assert.equal(link.local, true);
  app.syncMainShareWarning();
  assert.equal(app.els.mainShareLocalWarning.hidden, false);
  assert.match(attributes["aria-label"], /Local link warning/);
});

test("localhost and loopback copies use the hosted destination while public hosts retain their path", () => {
  for (const href of ["http://localhost:8080/app.html", "http://preview.localhost/app.html", "http://127.0.0.1:8080/app.html", "http://[::1]:8080/app.html"]) {
    const { app } = shareRuntime(href);
    assert.equal(new URL(app.currentViewShareLink().href).origin, "https://inasearch.pages.dev", href);
    app.profile.preferences.useHostedShareLinks = false;
    assert.equal(new URL(app.currentViewShareLink().href).origin, new URL(href).origin);
    assert.equal(app.currentViewShareLink().local, true);
  }
  for (const enabled of [true, false]) for (const href of ["https://example.test/tools/INASearch.html", "http://example.test/app", "https://localhost.example.test/app"]) {
    const { app } = shareRuntime(`${href}?old=1#old`, { useHostedShareLinks: enabled });
    const link = app.legalUnitShareLink("INA 101(a)(15)(H)(i)(b)");
    assert.equal(new URL(link.href).origin + new URL(link.href).pathname, href);
    assert.equal(new URL(link.href).searchParams.get("q"), "INA 101(a)(15)(H)(i)(b)");
    assert.equal(link.local, false);
  }
});

test("sharing still rejects empty queries, invalid addresses, and unsupported protocols", () => {
  const { app } = shareRuntime("file:///downloads/INASearch.html");
  assert.equal(app.legalUnitShareLink(" "), null);
  for (const href of ["not an address", "javascript:void(0)", "data:text/html,example"]) assert.equal(app.currentViewShareLink({ href }, "INA 245"), null);
});
