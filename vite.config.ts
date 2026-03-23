import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const VITE_FIREBASE_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_DATABASE_URL',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const

export default defineConfig(({ mode }) => {
  const fromFiles = loadEnv(mode, process.cwd(), 'VITE_')

  const defineEnv: Record<string, string> = {}
  for (const key of VITE_FIREBASE_KEYS) {
    const v = (process.env[key] ?? fromFiles[key] ?? '').trim()
    defineEnv[`import.meta.env.${key}`] = JSON.stringify(v)
  }
  defineEnv['import.meta.env.VITE_FIREBASE_EMAILS_PATH'] = JSON.stringify(
    (process.env.VITE_FIREBASE_EMAILS_PATH ?? fromFiles.VITE_FIREBASE_EMAILS_PATH ?? '').trim(),
  )
  defineEnv['import.meta.env.VITE_API_BASE_URL'] = JSON.stringify(
    (process.env.VITE_API_BASE_URL ?? fromFiles.VITE_API_BASE_URL ?? '').trim(),
  )

  if (process.env.VERCEL) {
    const missing = VITE_FIREBASE_KEYS.filter(
      (k) => !(process.env[k] ?? fromFiles[k])?.toString().trim(),
    )
    if (missing.length) {
      console.warn(
        '[habmail] Vercel-Build: folgende Variablen fehlen oder sind leer: ' +
          missing.join(', ') +
          '. In Vercel unter Environment Variables prüfen: exakte Schreibweise, für „Production“ (und ggf. „Preview“) aktiviert, danach Redeploy ohne Build-Cache.',
      )
    }
  }

  return {
    plugins: [react()],
    define: defineEnv,
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
  }
})
