/* @refresh reload */
import 'virtual:uno.css'
// Bundle webfonts so the choice in Settings -> Appearance works regardless of
// what's installed on the user's machine. Variable packages = single woff2
// per family covering the full weight range (Vite copies them to the build).
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import '@fontsource-variable/fira-code/wght.css'
import '@fontsource-variable/cascadia-code/wght.css'
import { render } from 'solid-js/web'
import App from './App'

const root = document.getElementById('root')!
render(() => <App />, root)
