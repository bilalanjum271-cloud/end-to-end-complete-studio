import type { Preview } from '@storybook/react';
import './storybook.css';
import { ToastProvider } from '../src/components/toast';
import { TooltipProvider } from '../src/components/tooltip';

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Theme', toolbar: { icon: 'mirror', items: ['dark', 'light'], dynamicTitle: true } },
    dir: { description: 'Direction', toolbar: { icon: 'transfer', items: ['ltr', 'rtl'], dynamicTitle: true } },
  },
  initialGlobals: { theme: 'dark', dir: 'ltr' },
  decorators: [
    (Story, ctx) => {
      document.documentElement.dataset.theme = ctx.globals.theme;
      document.documentElement.dir = ctx.globals.dir;
      return (
        <TooltipProvider delayDuration={200}>
          <ToastProvider>
            <div className="min-h-64 bg-bg p-8 text-fg"><Story /></div>
          </ToastProvider>
        </TooltipProvider>
      );
    },
  ],
};
export default preview;
