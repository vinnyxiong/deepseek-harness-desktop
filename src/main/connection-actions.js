class ConnectionActions {
  constructor() {
    this.transaction = Promise.resolve();
  }

  run(action) {
    const result = this.transaction.then(action, action);
    this.transaction = result.catch(() => {});
    return result;
  }

  async idle() {
    await this.transaction.catch(() => {});
  }
}

module.exports = { ConnectionActions };
