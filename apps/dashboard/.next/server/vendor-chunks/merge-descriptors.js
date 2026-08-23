"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/merge-descriptors";
exports.ids = ["vendor-chunks/merge-descriptors"];
exports.modules = {

/***/ "(rsc)/../facilitator/node_modules/merge-descriptors/index.js":
/*!**************************************************************!*\
  !*** ../facilitator/node_modules/merge-descriptors/index.js ***!
  \**************************************************************/
/***/ ((module) => {

eval("\n\nfunction mergeDescriptors(destination, source, overwrite = true) {\n\tif (!destination) {\n\t\tthrow new TypeError('The `destination` argument is required.');\n\t}\n\n\tif (!source) {\n\t\tthrow new TypeError('The `source` argument is required.');\n\t}\n\n\tfor (const name of Object.getOwnPropertyNames(source)) {\n\t\tif (!overwrite && Object.hasOwn(destination, name)) {\n\t\t\t// Skip descriptor\n\t\t\tcontinue;\n\t\t}\n\n\t\t// Copy descriptor\n\t\tconst descriptor = Object.getOwnPropertyDescriptor(source, name);\n\t\tObject.defineProperty(destination, name, descriptor);\n\t}\n\n\treturn destination;\n}\n\nmodule.exports = mergeDescriptors;\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHJzYykvLi4vZmFjaWxpdGF0b3Ivbm9kZV9tb2R1bGVzL21lcmdlLWRlc2NyaXB0b3JzL2luZGV4LmpzIiwibWFwcGluZ3MiOiJBQUFhOztBQUViO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7O0FBRUEiLCJzb3VyY2VzIjpbIi9ob21lL2NoaXJhZy9EZXNrdG9wL3Jhem9ycGF5X2J1aWxkYXRob24vZmlhdDQwMi9hcHBzL2ZhY2lsaXRhdG9yL25vZGVfbW9kdWxlcy9tZXJnZS1kZXNjcmlwdG9ycy9pbmRleC5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIndXNlIHN0cmljdCc7XG5cbmZ1bmN0aW9uIG1lcmdlRGVzY3JpcHRvcnMoZGVzdGluYXRpb24sIHNvdXJjZSwgb3ZlcndyaXRlID0gdHJ1ZSkge1xuXHRpZiAoIWRlc3RpbmF0aW9uKSB7XG5cdFx0dGhyb3cgbmV3IFR5cGVFcnJvcignVGhlIGBkZXN0aW5hdGlvbmAgYXJndW1lbnQgaXMgcmVxdWlyZWQuJyk7XG5cdH1cblxuXHRpZiAoIXNvdXJjZSkge1xuXHRcdHRocm93IG5ldyBUeXBlRXJyb3IoJ1RoZSBgc291cmNlYCBhcmd1bWVudCBpcyByZXF1aXJlZC4nKTtcblx0fVxuXG5cdGZvciAoY29uc3QgbmFtZSBvZiBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyhzb3VyY2UpKSB7XG5cdFx0aWYgKCFvdmVyd3JpdGUgJiYgT2JqZWN0Lmhhc093bihkZXN0aW5hdGlvbiwgbmFtZSkpIHtcblx0XHRcdC8vIFNraXAgZGVzY3JpcHRvclxuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Ly8gQ29weSBkZXNjcmlwdG9yXG5cdFx0Y29uc3QgZGVzY3JpcHRvciA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3Ioc291cmNlLCBuYW1lKTtcblx0XHRPYmplY3QuZGVmaW5lUHJvcGVydHkoZGVzdGluYXRpb24sIG5hbWUsIGRlc2NyaXB0b3IpO1xuXHR9XG5cblx0cmV0dXJuIGRlc3RpbmF0aW9uO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IG1lcmdlRGVzY3JpcHRvcnM7XG4iXSwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbMF0sInNvdXJjZVJvb3QiOiIifQ==\n//# sourceURL=webpack-internal:///(rsc)/../facilitator/node_modules/merge-descriptors/index.js\n");

/***/ })

};
;