// Unit-test config, mirroring vscode-js-debug's .mocharc.unit.js.
// Run via: tsx node_modules/mocha/bin/mocha.js --config .mocharc.unit.js
// tsx transpiles the *.test.ts specs on the fly, so no separate build step.
module.exports = {
  spec: "src/**/*.test.ts",
  ignore: "src/test/**",
  timeout: 10000,
};
