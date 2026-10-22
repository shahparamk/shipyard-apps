const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

function createQueue() {
  const sqs = new SQSClient({
    region: process.env.AWS_REGION || 'us-east-1',
    // Locally we point at an SQS emulator; in AWS this is unset and the real SQS endpoint is used
    ...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT } : {}),
  });
  const queueUrl = process.env.QUEUE_URL;

  return {
    async sendOrder(orderId) {
      await sqs.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ orderId }) })
      );
    },
  };
}

module.exports = { createQueue };