// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { gestureAllowed, isTyping } from './helpers'

const mount = (html: string): Element => {
  document.body.innerHTML = html

  return document.body.firstElementChild!
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isTyping', () => {
  it('claims nothing while the user is in a field', () => {
    expect(isTyping(mount('<input>'))).toBe(true)
    expect(isTyping(mount('<textarea></textarea>'))).toBe(true)

    // jsdom doesn't implement isContentEditable, so the editor surface (a
    // contenteditable div) is simulated the way a browser would report it.
    const editable = mount('<div>note</div>')
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isTyping(editable)).toBe(true)
  })

  it('leaves plain elements (and nothing at all) to us', () => {
    expect(isTyping(mount('<div>plain</div>'))).toBe(false)
    expect(isTyping(document.body)).toBe(false)
    expect(isTyping(null)).toBe(false)
  })
})

describe('gestureAllowed', () => {
  it('counts taps when focus rests on the page itself', () => {
    expect(gestureAllowed(null)).toBe(true)
    expect(gestureAllowed(document.body)).toBe(true)
    expect(gestureAllowed(mount('<div class="canvas"></div>'))).toBe(true)
  })

  it('refuses while a control has focus — there the space bar is ITS activation', () => {
    // Five taps on a focused button are five clicks the user asked for; treating
    // them as a secret handshake would fire the button AND open the mode.
    expect(gestureAllowed(mount('<button>zoom in</button>'))).toBe(false)
    expect(gestureAllowed(mount('<a href="/x">link</a>'))).toBe(false)
    expect(gestureAllowed(mount('<input>'))).toBe(false)
    expect(gestureAllowed(mount('<div role="button">fit</div>'))).toBe(false)
    expect(gestureAllowed(mount('<div tabindex="0">row</div>'))).toBe(false)
  })

  it('refuses for anything nested inside a control', () => {
    mount('<button><span id="icon">+</span></button>')
    expect(gestureAllowed(document.getElementById('icon'))).toBe(false)
  })

  it('refuses behind a modal, the way the app dispatcher does', () => {
    document.body.innerHTML = '<div aria-modal="true">dialog</div>'
    expect(gestureAllowed(document.body)).toBe(false)
  })
})
