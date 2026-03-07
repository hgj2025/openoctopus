import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../assets/globals.css'
import { Options } from './Options'

const root = document.getElementById('root')!
createRoot(root).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
)
