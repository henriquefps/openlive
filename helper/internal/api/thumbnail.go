// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/henriquefps/openlive/helper/internal/thumbnail"
)

// PutThumbnail uploads the stream's latest snapshot (PUT .../streams/:streamId/thumbnail,
// PROTOCOL.md §11.3). placeholder marks the one frame sent when the stream pauses. A 4xx
// answer other than 429 is wrapped in thumbnail.ErrRefused: sending it again would not help.
func (c *Client) PutThumbnail(ctx context.Context, roomID, streamID string, jpeg []byte, placeholder bool) error {
	header := http.Header{}
	header.Set("Content-Type", "image/jpeg")
	if placeholder {
		header.Set("X-Openlive-Thumbnail", "paused")
	}
	path := fmt.Sprintf(pathThumbnailFmt, url.PathEscape(roomID), url.PathEscape(streamID))
	err := c.DoRaw(ctx, http.MethodPut, path, jpeg, header, nil)
	var apiErr *Error
	if errors.As(err, &apiErr) && apiErr.Status >= 400 && apiErr.Status < 500 && apiErr.Status != http.StatusTooManyRequests {
		return fmt.Errorf("%w: %w", thumbnail.ErrRefused, err)
	}
	return err
}
