if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('offline-worker.js', import.meta.url), {updateViaCache: 'none'}).catch(() => {
    // The page still works normally when storage or service workers are unavailable.
  });
}
