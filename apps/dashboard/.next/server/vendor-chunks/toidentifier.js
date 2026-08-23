"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/toidentifier";
exports.ids = ["vendor-chunks/toidentifier"];
exports.modules = {

/***/ "(rsc)/../facilitator/node_modules/toidentifier/index.js":
/*!*********************************************************!*\
  !*** ../facilitator/node_modules/toidentifier/index.js ***!
  \*********************************************************/
/***/ ((module) => {

eval("/*!\n * toidentifier\n * Copyright(c) 2016 Douglas Christopher Wilson\n * MIT Licensed\n */\n\n\n\n/**\n * Module exports.\n * @public\n */\n\nmodule.exports = toIdentifier\n\n/**\n * Trasform the given string into a JavaScript identifier\n *\n * @param {string} str\n * @returns {string}\n * @public\n */\n\nfunction toIdentifier (str) {\n  return str\n    .split(' ')\n    .map(function (token) {\n      return token.slice(0, 1).toUpperCase() + token.slice(1)\n    })\n    .join('')\n    .replace(/[^ _0-9a-z]/gi, '')\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHJzYykvLi4vZmFjaWxpdGF0b3Ivbm9kZV9tb2R1bGVzL3RvaWRlbnRpZmllci9pbmRleC5qcyIsIm1hcHBpbmdzIjoiQUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVZOztBQUVaO0FBQ0E7QUFDQTtBQUNBOztBQUVBOztBQUVBO0FBQ0E7QUFDQTtBQUNBLFdBQVcsUUFBUTtBQUNuQixhQUFhO0FBQ2I7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsS0FBSztBQUNMO0FBQ0E7QUFDQSIsInNvdXJjZXMiOlsiL2hvbWUvY2hpcmFnL0Rlc2t0b3AvcmF6b3JwYXlfYnVpbGRhdGhvbi9maWF0NDAyL2FwcHMvZmFjaWxpdGF0b3Ivbm9kZV9tb2R1bGVzL3RvaWRlbnRpZmllci9pbmRleC5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKiFcbiAqIHRvaWRlbnRpZmllclxuICogQ29weXJpZ2h0KGMpIDIwMTYgRG91Z2xhcyBDaHJpc3RvcGhlciBXaWxzb25cbiAqIE1JVCBMaWNlbnNlZFxuICovXG5cbid1c2Ugc3RyaWN0J1xuXG4vKipcbiAqIE1vZHVsZSBleHBvcnRzLlxuICogQHB1YmxpY1xuICovXG5cbm1vZHVsZS5leHBvcnRzID0gdG9JZGVudGlmaWVyXG5cbi8qKlxuICogVHJhc2Zvcm0gdGhlIGdpdmVuIHN0cmluZyBpbnRvIGEgSmF2YVNjcmlwdCBpZGVudGlmaWVyXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHN0clxuICogQHJldHVybnMge3N0cmluZ31cbiAqIEBwdWJsaWNcbiAqL1xuXG5mdW5jdGlvbiB0b0lkZW50aWZpZXIgKHN0cikge1xuICByZXR1cm4gc3RyXG4gICAgLnNwbGl0KCcgJylcbiAgICAubWFwKGZ1bmN0aW9uICh0b2tlbikge1xuICAgICAgcmV0dXJuIHRva2VuLnNsaWNlKDAsIDEpLnRvVXBwZXJDYXNlKCkgKyB0b2tlbi5zbGljZSgxKVxuICAgIH0pXG4gICAgLmpvaW4oJycpXG4gICAgLnJlcGxhY2UoL1teIF8wLTlhLXpdL2dpLCAnJylcbn1cbiJdLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOlswXSwic291cmNlUm9vdCI6IiJ9\n//# sourceURL=webpack-internal:///(rsc)/../facilitator/node_modules/toidentifier/index.js\n");

/***/ })

};
;