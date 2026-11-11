import type { StorybookConfig } from '@storybook/react-vite';
import tailwind from '@tailwindcss/vite';

const config: StorybookConfig = {
  stories: ['../src/stories/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  viteFinal: (cfg) => ({ ...cfg, plugins: [...(cfg.plugins ?? []), tailwind()] }),
};
export default config;
