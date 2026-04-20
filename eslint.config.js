// ESLint flat config (v9+). Keeps the footprint small: TypeScript + Vue SFC, no
// stylistic rules (Prettier owns formatting). Run: `npm run lint`.
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  ...vue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      "vue/multi-word-component-names": "off",
      "vue/no-v-html": "off",
    },
  },
];
