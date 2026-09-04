import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('loads the workspace shell with the seeded bundle', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'Folio home' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'todo-list.md' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'start-here.md' })).toBeVisible()
})

test('reports Ollama as offline when no local model server is running', async ({ page }) => {
  await expect(page.getByText('Ollama offline')).toBeVisible()
})

test('opens a seeded note and shows its content', async ({ page }) => {
  await page.getByRole('button', { name: 'todo-list.md' }).click()
  await expect(page.getByRole('heading', { name: 'Todo List', level: 1 }).first()).toBeVisible()
  await expect(page.getByText('Add your first task')).toBeVisible()
})

test('creates a new local draft note from the editor', async ({ page }) => {
  await page.getByTitle('New note (Cmd+T)').click()
  const editor = page.getByLabel('Write a new note')
  await editor.fill('My first draft note')

  await expect(page.locator('.draft-tree-open', { hasText: 'My first draft note' })).toBeVisible()
})
