import {
  defineConfig,
  minimal2023Preset,
} from '@vite-pwa/assets-generator/config';

// `pnpm pwa:icons` writes the manifest and favicon icons from the logo.
export default defineConfig({
  preset: minimal2023Preset,
  images: ['public/favicon.svg'],
});
