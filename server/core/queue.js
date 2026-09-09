export function createSerialQueue() {
  let tail = Promise.resolve()
  return (callback) => {
    const operation = tail.then(callback, callback)
    tail = operation.catch(() => {})
    return operation
  }
}
