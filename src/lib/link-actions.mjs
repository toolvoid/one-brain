export async function runLinkMutation(action, refresh, onError) {
  try {
    await action();
    await refresh();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
