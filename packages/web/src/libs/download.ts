// Stream a file to disk via a transient anchor (a cookie-authenticated GET): the
// browser owns the download — it streams straight to disk and takes the real filename
// from the server's Content-Disposition — so even a large archive never sits in the
// tab's memory. Shared by the Export tab (#17/#105) and the tree's "Export folder".
export const triggerDownload = (href: string) => {
  const a = document.createElement('a')
  a.href = href
  a.rel = 'noopener'
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}
