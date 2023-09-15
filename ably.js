/*
WebSockets Extension
============================
This extension adds support for WebSockets to htmx.  See /www/extensions/ws.md for usage instructions.
*/

(function () {

	/** @type {import("../htmx").HtmxInternalApi} */
	var api;
	var clientElt;

	htmx.defineExtension("ably", {

		init: function (apiRef) {
			// Store reference to internal API
			api = apiRef;
		},

		onEvent: function (name, evt) {

			switch (name) {

				// Try to close the Ably client when elements are removed
				case "htmx:beforeCleanupElement":

					var internalData = api.getInternalData(evt.target)

					if (internalData.ablyClient) {
						internalData.ablyClient.close();
					}
					return;

				// Try to create Ably client when elements are processed
				case "htmx:beforeProcessNode":
					var parent = evt.target;

          forEach(queryAttributeOnThisOrChildren(parent, "ably-connect"), function(parent) {
            ensureAblyClient(parent)
          });

					forEach(queryAttributeOnThisOrChildren(parent, "ably-subscribe"), function (child) {
						ensureAblyChannelSubscription(child)
					});

          forEach(queryAttributeOnThisOrChildren(parent, "ably-publish"), function (child) {
						ensureAblyChannelPublish(child)
					});
      }
		}
	});

  function ensureAblyClient(clientElt) {

		if (!api.bodyContains(clientElt)) {
      console.log(`Parent element no longer exists. Abort.`);
			return;
		}

		//first check to see if we already have a client instance stored
    if (api.getInternalData(clientElt).ablyClient) {
			console.log(`Existing client wrapper instance found.  Reusing.`)
      return api.getInternalData(clientElt).ablyClient;
    }

    var key = api.getAttributeValue(clientElt, "ably-key")
    var authUrl = api.getAttributeValue(clientElt, "ably-authUrl")
    var clientId = api.getAttributeValue(clientElt, "ably-clientId")
    var authMethod = api.getAttributeValue(clientElt, "ably-authMethod")

    clientOptions = Object.assign({},
      key === null ? null : {key},
      authUrl === null ? null : {authUrl},
      authMethod === null ? null : {authMethod},
      clientId === null ? null : {clientId}
    );
    clientOptions.autoConnect = false;

    var ablyClientWrapper = createAblyClientWrapper(clientElt, function () {
      return Ably.Realtime.Promise(clientOptions);
    });

    // Put the Ably Client into the HTML Element's custom data.
		api.getInternalData(clientElt).ablyClient = ablyClientWrapper;
		this.clientElt = clientElt;
  }

  function ensureAblyChannelSubscription(subscribeElt) {

		// If the element containing the Ably channel connection no longer exists, then
		// do not connect/reconnect the Ably channel.
    // DMR: should this actually be checking to see if any page elements containing ably-connect are left in the page and if not close the connection
		if (!api.bodyContains(subscribeElt)) {
			return;
		}

		// Get the Ably Client from the HTML Element's custom data.
    var ablyClientWrapper = api.getInternalData(this.clientElt).ablyClient;

    var channelname = api.getAttributeValue(subscribeElt, "ably-subscribe")
    var channel = ablyClientWrapper.client.channels.get(channelname)

		api.triggerEvent(subscribeElt, "htmx:ablyBeforeChannelSubscribe", { channel_name: channelname, ablyClientWrapper: ablyClientWrapper.publicInterface });
    channel.subscribe(function (message) {

      //if (maybeCloseAblyClientSource(socketElt)) {
      //  return;
      //} 

      var response = message.data;

		  if (!api.triggerEvent(subscribeElt, "htmx:ablyBeforeMessage", {
          message: response,
          ablyClientWrapper: ablyClientWrapper.publicInterface
      })) {
          return;
      }
    
      api.withExtensions(subscribeElt, function (extension) {
        response = extension.transformResponse(response, null, subscribeElt);
      });
    
      var settleInfo = api.makeSettleInfo(subscribeElt);
      var fragment = api.makeFragment(response);
        console.log(fragment)

      if (fragment.children.length) {
        var children = Array.from(fragment.children);
        for (var i = 0; i < children.length; i++) {
          api.oobSwap(api.getAttributeValue(children[i], "hx-swap-oob") || "true", children[i], settleInfo);
        }
      }

      api.settleImmediately(settleInfo.tasks);
      api.triggerEvent(subscribeElt, "htmx:ablyAfterMessage", { message: response, ablyClientWrapper: ablyClientWrapper.publicInterface })
    });
		api.triggerEvent(subscribeElt, "htmx:ablyAfterChannelSubscribe", { channel_name: channelname, ablyClientWrapper: ablyClientWrapper.publicInterface });
	}

	function ensureAblyChannelPublish(elt) {
		var ablyClientParent = api.getClosestMatch(elt, hasAblyClient)
		processAblyClientSend(ablyClientParent, elt);
	}

	function createAblyClientWrapper(clientElt, clientFunc) {
		var wrapper = {
			client: null,
			messageQueue: [],

			sendImmediately: function (message, sendElt) {

				if (!this.client) {
					api.triggerErrorEvent()
				}

				if (sendElt && api.triggerEvent(sendElt, 'htmx:ablyBeforeSend', {
					message: message,
					ablyClientWrapper: this.publicInterface
				})) {
					var channelname = api.getAttributeValue(sendElt, "ably-send")
					var ablyClientWrapper = api.getInternalData(clientElt).ablyClient;
					var channel = ablyClientWrapper.client.channels.get(channelname)
					channel.publish("ably-send", message);
					
					sendElt && api.triggerEvent(sendElt, 'htmx:ablyAfterSend', {
						message: message,
						ablyClientWrapper: this.publicInterface
					})
				}
			},

			send: function (message, sendElt) {
        //make sure the ably client state is correct
				if (this.client.connection.state !== "connected") {
					this.messageQueue.push({ message: message, sendElt: sendElt });
				} else {
					this.sendImmediately(message, sendElt);
				}
			},

			handleQueuedMessages: function () {
				while (this.messageQueue.length > 0) {
					var queuedItem = this.messageQueue[0]
					if (this.socket.readyState === this.socket.OPEN) {
						this.sendImmediately(queuedItem.message, queuedItem.sendElt);
						this.messageQueue.shift();
					} else {
						break;
					}
				}
			},

			init: function () {

				var client = clientFunc();

        // The event.type detail is added for interface conformance with the
				// other two lifecycle events (open and close) so a single handler method
				// can handle them polymorphically, if required.
        client.connection.on('connected', (stateChange) => {
          api.triggerEvent(clientElt, "htmx:ablyConnecting", { event: { type: 'connecting' } });
        });

        client.connection.on('connected', (stateChange) => {
					api.triggerEvent(clientElt, "htmx:ablyConnected", { event: stateChange, ablyClientWrapper: wrapper.publicInterface });
        });

        client.connection.on('disconnected', (stateChange) => {
					api.triggerEvent(clientElt, "htmx:ablyDisconnected", { event: stateChange, ablyClientWrapper: wrapper.publicInterface })
        });

        client.connection.on('suspended', (stateChange) => {
					api.triggerEvent(clientElt, "htmx:ablySuspended", { event: stateChange, ablyClientWrapper: wrapper.publicInterface })
        });

        client.connection.on('closed', (stateChange) => {
					api.triggerEvent(clientElt, "htmx:ablyClosed", { event: stateChange, ablyClientWrapper: wrapper.publicInterface })
        });

        client.connection.on('failed', (stateChange) => {
					api.triggerErrorEvent(clientElt, "htmx:ablyFailed", { error: stateChange, ablyClientWrapper: wrapper });
					maybeCloseAblyClientSource(clientElt);
        });

				this.client = client;

        client.connect();
			},

			close: function () {
				this.client.close()
			}
		}

		wrapper.init();

		wrapper.publicInterface = {
			send: wrapper.send.bind(wrapper),
			sendImmediately: wrapper.sendImmediately.bind(wrapper),
			queue: wrapper.messageQueue
		};

		return wrapper;
	}

	function hasAblyClient(node) {
		var result = api.getInternalData(node).ablyClient != null;
    return result;
	}

	function processAblyClientSend(socketElt, sendElt) {
		var nodeData = api.getInternalData(sendElt);
		var triggerSpecs = api.getTriggerSpecs(sendElt);

		triggerSpecs.forEach(function (ts) {
			api.addTriggerHandler(sendElt, ts, nodeData, function (elt, evt) {
				//if (maybeCloseAblyClientSource(socketElt)) {
				//	return;
				//}

				var ablyClientWrapper = api.getInternalData(socketElt).ablyClient;
				var headers = api.getHeaders(sendElt, api.getTarget(sendElt));
				var results = api.getInputValues(sendElt, 'post');
				var errors = results.errors;
				var rawParameters = results.values;
				var expressionVars = api.getExpressionVars(sendElt);
				var allParameters = api.mergeObjects(rawParameters, expressionVars);
				var filteredParameters = api.filterValues(allParameters, sendElt);
				
				var sendConfig = {
					parameters: filteredParameters,
					unfilteredParameters: allParameters,
					headers: headers,
					errors: errors,

					triggeringEvent: evt,
					messageBody: undefined,
					ablyClientWrapper: ablyClientWrapper.publicInterface
				};

				if (!api.triggerEvent(elt, 'htmx:ablyConfigSend', sendConfig)) {
					return;
				}

				if (errors && errors.length > 0) {
					api.triggerEvent(elt, 'htmx:validation:halted', errors);
					return;
				}

				var body = sendConfig.messageBody;
				if (body === undefined) {
					var toSend = Object.assign({}, sendConfig.parameters);
					if (sendConfig.headers)
						toSend['HEADERS'] = headers;
					body = JSON.stringify(toSend);
				}

				ablyClientWrapper.send(body, elt);

				if (api.shouldCancel(evt, elt)) {
					evt.preventDefault();
				}
			});
		});
	}

	function maybeCloseAblyClientSource(elt) {
		if (!api.bodyContains(elt)) {
			api.getInternalData(elt).ablyClient.close();
			return true;
		}
		return false;
	}

	function queryAttributeOnThisOrChildren(elt, attributeName) {

		var result = []
		// If the parent element also contains the requested attribute, then add it to the results too.
		if (api.hasAttribute(elt, attributeName) || api.hasAttribute(elt, "hx-ably")) {
			result.push(elt);
		}

		// Search all child nodes that match the requested attribute
		elt.querySelectorAll("[" + attributeName + "], [data-" + attributeName + "], [data-hx-ably], [hx-ably]").forEach(function (node) {
			result.push(node)
		})
		return result
	}

	function forEach(arr, func) {
		if (arr) {
			for (var i = 0; i < arr.length; i++) {
				func(arr[i]);
			}
		}
	}

})();
