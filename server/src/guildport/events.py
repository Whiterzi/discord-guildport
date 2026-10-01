import asyncio


class EventHub:
    """Only keeps bounded queues for connected clients; never archives messages."""
    def __init__(self):
        self.listeners = {}

    def subscribe(self, channel_id):
        queue = asyncio.Queue(maxsize=100)
        self.listeners.setdefault(channel_id, set()).add(queue)
        return queue

    def unsubscribe(self, channel_id, queue):
        listeners = self.listeners.get(channel_id, set())
        listeners.discard(queue)
        if not listeners:
            self.listeners.pop(channel_id, None)

    def publish(self, channel_id, event):
        for queue in list(self.listeners.get(str(channel_id), ())):
            if queue.full():
                # Disconnect slow consumers; never silently lose a single message.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "resync_required"})
            else:
                queue.put_nowait(event)
