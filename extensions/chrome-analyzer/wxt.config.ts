import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

export default defineConfig({
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'AI Page Analyzer',
    description: 'AI-powered page performance analysis and UI testing',
    version: '0.1.0',
    permissions: [
      'activeTab',
      'scripting',
      'storage',
      'sidePanel',
      'debugger',
      'tabs',
    ],
    optional_permissions: ['identity'],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    action: {
      default_title: 'AI Page Analyzer',
      default_icon: {
        '16': 'icons/16.png',
        '48': 'icons/48.png',
        '128': 'icons/128.png',
      },
    },
    icons: {
      '16': 'icons/16.png',
      '48': 'icons/48.png',
      '128': 'icons/128.png',
    },
  },
})
