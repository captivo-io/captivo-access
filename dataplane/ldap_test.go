package main

import (
	"testing"

	"github.com/go-ldap/ldap/v3"
)

func TestEntryToResolve(t *testing.T) {
	e := &ldap.Entry{
		DN: "CN=Jane,OU=Users,DC=corp,DC=local",
		Attributes: []*ldap.EntryAttribute{
			{Name: "memberOf", Values: []string{"CN=Admins,OU=Groups,DC=corp,DC=local", "CN=DB-Ops,OU=Groups,DC=corp,DC=local"}},
			{Name: "displayName", Values: []string{"Jane Doe"}},
		},
	}
	got := entryToResolve(e)
	if !got.Found {
		t.Fatalf("expected Found=true")
	}
	if got.DN != "CN=Jane,OU=Users,DC=corp,DC=local" {
		t.Fatalf("DN mismatch: %q", got.DN)
	}
	if len(got.MemberOf) != 2 || got.MemberOf[0] != "CN=Admins,OU=Groups,DC=corp,DC=local" {
		t.Fatalf("MemberOf mismatch: %v", got.MemberOf)
	}
	if got.DisplayName != "Jane Doe" {
		t.Fatalf("DisplayName mismatch: %q", got.DisplayName)
	}
}

func TestGroupSearchFilterEscapesInput(t *testing.T) {
	got := groupSearchFilter("ops*)(cn=x")
	want := `(&(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))(|(cn=*ops\2a\29\28cn=x*)(sAMAccountName=*ops\2a\29\28cn=x*)))`
	if got != want {
		t.Fatalf("filter mismatch:\n got %s\nwant %s", got, want)
	}
	if _, err := ldap.CompileFilter(groupSearchFilter("Captivo Admins")); err != nil {
		t.Fatalf("filter does not compile: %v", err)
	}
}

func TestEntriesToGroups(t *testing.T) {
	got := entriesToGroups([]*ldap.Entry{
		{DN: "CN=DB-Ops,OU=Groups,DC=corp,DC=local", Attributes: []*ldap.EntryAttribute{{Name: "cn", Values: []string{"DB-Ops"}}, {Name: "description", Values: []string{"Database team"}}}},
		{DN: "CN=x,DC=corp,DC=local", Attributes: []*ldap.EntryAttribute{{Name: "sAMAccountName", Values: []string{"legacy-x"}}}},
		{DN: "", Attributes: []*ldap.EntryAttribute{{Name: "cn", Values: []string{"referral"}}}},
	})
	if len(got) != 2 || got[0].Name != "DB-Ops" || got[0].Description != "Database team" || got[1].Name != "legacy-x" {
		t.Fatalf("groups mismatch: %+v", got)
	}
}

func TestSearchGroupsNeedsTwoCharacters(t *testing.T) {
	got := SearchGroups(nil, LdapConfig{}, " a ")
	if got.Error != "" || len(got.Groups) != 0 {
		t.Fatalf("short query should return no groups and no error: %+v", got)
	}
}
