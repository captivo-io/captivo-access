package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jfjallid/go-smb/dcerpc/mssamr"
	"github.com/jfjallid/go-smb/msdtyp"
)

// Windows: the account joins the server's local Administrators group (alias
// 544 of the Builtin domain) over SMB, as the administrator account, and
// leaves it when the last session closes. An account that is already a member
// stays one: nothing of ours to take away.

const (
	maximumAllowed   = 0x02000000
	aliasAdminsRID   = 544
	statusNoneMapped = 0xc0000073
)

type windowsElev struct{ t *windowsTarget }

// samrSession is a signed-in samr connection with the two domains open.
type samrSession struct {
	r      *mssamr.RPCCon
	local  *mssamr.SamrHandle // the server's own accounts
	closer []func()
}

func (s *samrSession) close() {
	for i := len(s.closer) - 1; i >= 0; i-- {
		s.closer[i]()
	}
}

// openSamr signs in as the reconcile account and opens the local account
// domain. The caller closes it.
func (t *windowsTarget) openSamr(ctx context.Context) (*samrSession, *mssamr.SamrHandle, error) {
	domain, user := windowsCredential(t.reconcile.username)
	c, err := t.connect(ctx, domain, user, t.reconcile.secret)
	if err != nil {
		return nil, nil, fmt.Errorf("could not sign in to the server over SMB: %v", err)
	}
	s := &samrSession{closer: []func(){c.Close}}
	r, err := samrOver(c)
	if err != nil {
		s.close()
		return nil, nil, fmt.Errorf("could not open the account service (samr): %v", err)
	}
	s.r = r
	denied := func(err error) error {
		if code, _ := ntStatus(err); code == ntAccessDenied {
			return errors.New("the administrator account has no administrator right over the network: use the built-in Administrator or a domain account in the server's Administrators group")
		}
		return err
	}
	h, err := r.SamrConnect5("")
	if err != nil {
		s.close()
		return nil, nil, denied(err)
	}
	s.closer = append(s.closer, func() { _ = r.SamrCloseHandle(h) })
	doms, err := r.SamrEnumDomains(h)
	if err != nil {
		s.close()
		return nil, nil, denied(err)
	}
	var local string
	for _, d := range doms {
		if !strings.EqualFold(d, "Builtin") {
			local = d
			break
		}
	}
	if local == "" {
		s.close()
		return nil, nil, errors.New("the server lists no local account domain")
	}
	open := func(name string) (*mssamr.SamrHandle, error) {
		sid, err := r.SamrLookupDomain(h, name)
		if err != nil {
			return nil, denied(err)
		}
		dh, err := r.SamrOpenDomain(h, maximumAllowed, sid)
		if err != nil {
			return nil, denied(err)
		}
		s.closer = append(s.closer, func() { _ = r.SamrCloseHandle(dh) })
		return dh, nil
	}
	if s.local, err = open(local); err != nil {
		s.close()
		return nil, nil, err
	}
	builtin, err := open("Builtin")
	if err != nil {
		s.close()
		return nil, nil, err
	}
	return s, builtin, nil
}

// adminsAlias opens the Administrators group.
func (s *samrSession) adminsAlias(builtin *mssamr.SamrHandle) (*mssamr.SamrHandle, error) {
	ah, err := s.r.SamrOpenAlias(builtin, maximumAllowed, aliasAdminsRID)
	if err != nil {
		return nil, fmt.Errorf("could not open the Administrators group: %v", err)
	}
	s.closer = append(s.closer, func() { _ = s.r.SamrCloseHandle(ah) })
	return ah, nil
}

// accountSID is the account's SID in the server's own domain.
func (s *samrSession) accountSID(name string) (*msdtyp.SID, error) {
	ids, err := s.r.SamrLookupNamesInDomain(s.local, []string{name})
	if err != nil {
		if code, _ := ntStatus(err); code == statusNoneMapped {
			return nil, fmt.Errorf("the server has no local account %q", name)
		}
		return nil, err
	}
	if len(ids) != 1 {
		return nil, fmt.Errorf("the server has no local account %q", name)
	}
	return s.r.SamrRidToSid(s.local, ids[0].RID)
}

func hasSID(members []msdtyp.SID, sid *msdtyp.SID) bool {
	for i := range members {
		if members[i].ToString() == sid.ToString() {
			return true
		}
	}
	return false
}

func (w *windowsElev) grant(ctx context.Context) (bool, error) {
	s, builtin, err := w.t.openSamr(ctx)
	if err != nil {
		return false, err
	}
	defer s.close()
	sid, err := s.accountSID(w.t.username)
	if err != nil {
		return false, err
	}
	ah, err := s.adminsAlias(builtin)
	if err != nil {
		return false, err
	}
	members, err := s.r.SamrGetMembersInAlias(ah)
	if err != nil {
		return false, fmt.Errorf("could not read the Administrators group: %v", err)
	}
	if hasSID(members, sid) {
		return true, nil
	}
	if err := s.r.SamrAddMemberToAlias(ah, sid); err != nil {
		return false, fmt.Errorf("could not add the account to the Administrators group: %v", err)
	}
	return false, nil
}

func (w *windowsElev) revoke(ctx context.Context) error {
	s, builtin, err := w.t.openSamr(ctx)
	if err != nil {
		return err
	}
	defer s.close()
	sid, err := s.accountSID(w.t.username)
	if err != nil {
		return err
	}
	ah, err := s.adminsAlias(builtin)
	if err != nil {
		return err
	}
	if err := s.r.SamrRemoveMemberFromAlias(ah, sid); err != nil {
		// STATUS_MEMBER_NOT_IN_ALIAS: it is already out.
		if code, _ := ntStatus(err); code == 0xc0000121 || strings.Contains(strings.ToLower(err.Error()), "not in alias") {
			return nil
		}
		return fmt.Errorf("could not take the account out of the Administrators group: %v", err)
	}
	return nil
}

// filetimeToTime reads a Windows FILETIME (100 ns since 1601); the zero and
// "never" values give the zero time.
func filetimeToTime(f msdtyp.Filetime) time.Time {
	v := uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime)
	if v == 0 || v == 0x7fffffffffffffff {
		return time.Time{}
	}
	return time.Unix(int64(v/10_000_000)-11644473600, 0)
}
