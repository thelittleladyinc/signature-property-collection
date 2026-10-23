"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION = void 0;
// suite-kit: the shared toolkit for Christine Gwinnup's apps. One copy of each helper the Duplication Audit
// (Oct 11) found cloned across the apps. See ../README.md for what is here, why it is vendored, and how an
// app takes a copy.
__exportStar(require("./contact.js"), exports);
__exportStar(require("./address.js"), exports);
__exportStar(require("./denver-time.js"), exports);
__exportStar(require("./auth.js"), exports);
__exportStar(require("./lofty.js"), exports);
__exportStar(require("./mls-grid.js"), exports);
__exportStar(require("./hub.js"), exports);
__exportStar(require("./google-signin.js"), exports);
__exportStar(require("./parity.js"), exports);
var version_ts_1 = require("./version.js");
Object.defineProperty(exports, "VERSION", { enumerable: true, get: function () { return version_ts_1.VERSION; } });
